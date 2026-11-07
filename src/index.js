import cron from 'node-cron';
import { config, assertConfig } from './config.js';
import { log } from './logger.js';
import { Gateway } from './qq/gateway.js';
import { handleAtMessage } from './features/atReply.js';
import { ingestMessage } from './features/ingest.js';
import { pushDigest, pushWeekly } from './features/digest.js';
import { pushReminder } from './features/remind.js';
import { scanCourses } from './features/course.js';
import { runBackup } from './features/backup.js';
import { pruneOld as pruneMessageArchive } from './store/messages.js';
import { closeExpiredNoDue, autoCloseOverdue, knownGroups } from './store/todos.js';
import { listCourses } from './store/courses.js';
import { llmEnabled } from './llm.js';
import { SchemaTooNewError } from './store/schema.js';
import {
  rememberGroup,
  resolveTargets,
  listGroups,
  bootstrapFirstGroup,
} from './store/groups.js';

assertConfig();

/**
 * 数据文件版本比程序新时，这里就要退出。
 *
 * 三个 store 都是懒加载，启动后第一处触发 load() 的是下面的 runAutoClose()，
 * 而它外面套着 try/catch，会把版本错误当成「自动销项失败」记一行日志然后继续跑。
 * 带着读不懂的数据继续跑，下一次 save() 就可能把用户的数据覆盖掉。
 * 所以启动时主动把三个文件读一遍，让错误在最干净的时候暴露出来。
 */
function assertDataReadable() {
  listGroups();
  listCourses();
  knownGroups();
}

/**
 * 退出码 78 = 配置/数据不兼容，systemd 的 RestartPreventExitStatus 认这个码，
 * 看到就不重启了。否则 Restart=always 会每 5 秒重拉一次，日志刷屏还查不到重点。
 */
const EXIT_SCHEMA_TOO_NEW = 78;

try {
  assertDataReadable();
} catch (err) {
  if (err instanceof SchemaTooNewError) {
    log.error(err.message);
    log.error(`已停止启动（退出码 ${EXIT_SCHEMA_TOO_NEW}），数据文件没有被改动。`);
    process.exit(EXIT_SCHEMA_TOO_NEW);
  }
  throw err;
}

// 群消息原文存档只保留最近 7 天，启动时清一次过期的。
// 不用定时任务：多一个 timer 就多一个会悄悄停掉的东西，而这件事每天最多差一天。
// 放在数据可读性检查之后：数据都读不懂了就先停下，别急着动磁盘上的东西。
const pruned = pruneMessageArchive();
if (pruned) log.info(`清理过期消息存档 ${pruned} 个文件`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function targets() {
  return resolveTargets();
}

/**
 * 收到任何群消息就登记该群。
 * 第一个被发现的群还会顺手把 pending 占位群里的待办认领过来，
 * 这样部署完把机器人拉进群 @ 一下，整套就通了，不用再去抄 OpenID。
 */
function trackGroup(openid, name) {
  const { isNew, count } = rememberGroup(openid, { name });
  if (!isNew) return;
  log.info(`发现新群 ${openid}${name ? `（${name}）` : ''}，已知群共 ${count} 个`);

  const moved = bootstrapFirstGroup(openid);
  if (moved) log.info(`已把 pending 里的 ${moved} 条待办认领到这个群`);
}

const gateway = new Gateway({
  onEvent: async (type, d) => {
    if (type === 'GROUP_AT_MESSAGE_CREATE') {
      trackGroup(d.group_openid);
      await handleAtMessage(d);
    } else if (type === 'GROUP_MESSAGE_CREATE') {
      trackGroup(d.group_openid);
      await ingestMessage(d);
    }
  },
});

let digestRunning = false;

/**
 * 每月主动消息配额只有 4 条左右，而有的月份会出现第 5 个周六。
 *
 * 用一个与月份长度无关的判据：只放行 1—28 号。
 * 任何星期几在 1—28 号之间都恰好出现 4 次，29—31 号属于第 5 周，直接跳过。
 * 这样无论 cron 定在周几，每个自然月都稳定发 4 次，永远不撞配额上限。
 */
function isPushDay(d = new Date()) {
  return d.getDate() <= 28;
}

async function runDigest() {
  if (config.weeklyOnly && !isPushDay()) {
    log.debug('今天是本月第 5 周（29 号之后），跳过本轮以保住配额');
    return;
  }
  if (digestRunning) {
    log.warn('上一轮周报尚未结束，跳过本次');
    return;
  }
  digestRunning = true;
  const groups = targets();
  if (!groups.length) {
    log.warn('还没有已知群，跳过周报（先把机器人拉进群并 @ 它一下）');
    digestRunning = false;
    return;
  }
  for (const group of groups) {
    try {
      const result = await pushWeekly(group);
      // 跳过时 result 里没有 count，照旧打日志会变成「已发送 undefined 项」。
      // 跳过原因 pushWeekly 自己已经记过了，这里不再重复一遍。
      if (result?.sent) log.info(`周报 ${group}: 已发送 ${result.count} 项`);
    } catch (err) {
      log.error(`周报推送失败 ${group}: ${err.message}`);
    }
    await sleep(600);
  }
  digestRunning = false;
}

let remindRunning = false;

async function runRemind() {
  if (remindRunning) return;
  remindRunning = true;
  const groups = targets();
  for (const group of groups) {
    try {
      const result = await pushReminder(group);
      if (result.sent) log.info(`提醒 ${group}: ${result.count} 项`);
    } catch (err) {
      log.error(`提醒推送失败 ${group}: ${err.message}`);
    }
    await sleep(600);
  }
  remindRunning = false;
}

const jobs = [];

jobs.push(
  cron.schedule(config.digestCron, runDigest, { timezone: config.timezone })
);
// 到期提醒走主动消息，会跟周报抢每月那几条配额，所以默认关闭（REMIND_CRON 留空即可）
if (config.remindCron) {
  jobs.push(
    cron.schedule(config.remindCron, runRemind, { timezone: config.timezone })
  );
}
// 每周清理一次长期无截止日、也没人动的待办
jobs.push(
  cron.schedule('0 3 * * 1', () => {
    const n = closeExpiredNoDue(30);
    if (n) log.info(`清理了 ${n} 条 30 天未更新的无截止待办`);
  }, { timezone: config.timezone })
);

// 自动销项：过了截止日还没人销的归档掉，不需要手动 #完成
function runAutoClose() {
  try {
    const n = autoCloseOverdue();
    if (n) log.info(`自动销项 ${n} 条（已过截止日）`);
    return n;
  } catch (err) {
    log.error('自动销项失败：', err.message);
    return 0;
  }
}

if (config.autoClose) {
  // 启动时先跑一次，避免停机几天后积压一堆过期项
  runAutoClose();
  jobs.push(
    cron.schedule(config.autoCloseCron, runAutoClose, { timezone: config.timezone })
  );
}

// 数据快照：每天一次，保留最近 N 份。防的是机器人自己把 JSON 写坏，
// 机器整台没了这招救不回来，异地备份还得靠 scp 拉走。
if (config.backup) {
  jobs.push(
    cron.schedule(
      config.backupCron,
      () => {
        try {
          const r = runBackup();
          if (r.empty) return;
          const name = r.file.split(/[\\/]/).pop();
          log.info(`数据快照 ${name}（${Math.round(r.size / 1024)}KB）`);
        } catch (err) {
          log.error('数据快照失败：', err.message);
        }
      },
      { timezone: config.timezone }
    )
  );
}

// 课程提醒：每分钟扫描一次，命中提醒窗口就推送。
// 每次推送都是一条主动消息，会把周报的月度配额吃光，所以默认关闭（COURSE_PUSH=true 才开）。
let courseScanning = false;
if (config.coursePush) {
  jobs.push(
    cron.schedule('* * * * *', async () => {
      if (courseScanning) return;
      courseScanning = true;
      try {
        const hits = await scanCourses();
        if (hits.length) log.info(`本轮课程提醒：${hits.length} 条`);
      } catch (err) {
        log.error('课程提醒扫描失败：', err.message);
      } finally {
        courseScanning = false;
      }
    }, { timezone: config.timezone })
  );
}

log.info(`时区 ${config.timezone}`);
log.info(
  `周报计划：${config.digestCron}（${
    config.weeklyOnly ? '只发 1-28 号，第 5 周跳过' : '按 cron 原样'
  }，单条发送）`
);
log.info(
  config.remindCron
    ? `到期提醒：${config.remindCron}（会占用主动消息配额）`
    : '到期提醒：已关闭（REMIND_CRON 留空）'
);
log.info(
  config.coursePush
    ? '课程主动提醒：已开启（会占用主动消息配额）'
    : '课程主动提醒：已关闭'
);
log.info(
  config.autoClose
    ? `自动销项：${config.autoCloseCron}（过截止日即归档）`
    : '自动销项：已关闭'
);
log.info(
  config.backup
    ? `数据快照：${config.backupCron}（保留 ${config.backupKeep} 份）`
    : '数据快照：已关闭'
);
log.info(`群消息模式：${config.fullMessageMode ? '全量（自动抽取）' : '仅 @ 机器人'}`);
log.info(
  `待办抽取：${
    llmEnabled()
      ? '大模型'
      : config.ruleExtract
        ? '规则版（未配 LLM_API_KEY，只认结构明确的句子）'
        : '已关闭（只认 #待办 指令）'
  }`
);
log.info(
  `无截止日的退场次数：日期待定 ${config.pendingShowLimit} 次、无期限 ${config.ongoingShowLimit} 次（超了不再推送，库里仍保留）`
);
const boot = listGroups();
if (boot.length) {
  log.info(`已登记 ${boot.length} 个群：${boot.map((g) => g.openid).join(', ')}`);
} else {
  log.info('还没登记任何群，把机器人拉进群 @ 它发一句「群ID」即可');
}

gateway.start().catch((err) => {
  log.error('启动失败：', err.message);
  process.exitCode = 1;
});

function shutdown(signal) {
  log.info(`收到 ${signal}，正在退出`);
  for (const job of jobs) {
    try {
      job.stop();
    } catch {
      /* ignore */
    }
  }
  gateway.stop();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('未捕获的 Promise 异常：', err));
