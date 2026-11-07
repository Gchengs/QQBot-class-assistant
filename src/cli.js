import fs from 'node:fs';
import path from 'node:path';
import { config, assertConfig, ROOT as ROOT_DIR } from './config.js';
import {
  listTodos,
  knownGroups,
  addTodo,
  groupStats,
  moveGroup,
  findByKeyword,
  updateTodo,
  autoCloseOverdue,
} from './store/todos.js';
import {
  renderSummary,
  renderDigest,
  renderReminderGroups,
  renderWeekly,
} from './features/render.js';
import { splitMessage } from './utils/chunk.js';
import { pushDigest, pushWeekly, pickWeeklyBuckets } from './features/digest.js';
import { pushReminder } from './features/remind.js';
import { parseDueDate, parseTime, today, addDays } from './utils/date.js';
import {
  addCourse,
  listCourses,
  removeCourse,
  importCourses,
  parseScheduleSpec,
} from './store/courses.js';
import { previewCourse, scanCourses, quietRisk } from './features/course.js';
import { listGroups, removeGroup, resolveTargets } from './store/groups.js';
import { runBackup, listBackups, restoreBackup } from './features/backup.js';
import { sendGroupMessage } from './qq/api.js';

const [, , cmd, ...args] = process.argv;

function usage() {
  console.log(`
用法：
  node src/cli.js doctor                          自检：环境、凭据、群登记、推送计划
  node src/cli.js groups                          查看已登记的群与推送目标
  node src/cli.js group forget <群openid>         把某个群从登记簿移除
  node src/cli.js todo import <文件> [群openid]   批量导入待办（不填群则存到 pending）
        文件格式：事项 | 截止时间 | 负责人 | 无期限/待定
          交报价单 | 11月10日 23:59 | 生活委员
          看 CAD 回放 | - | 全班 | 无期限
        后两列可省略；负责人写「全班/全体」等于不指定（周报里就是全体的事）
  node src/cli.js todo move <旧群名> <新群openid> 把某个群名下的待办整体搬到真实群
  node src/cli.js list <群openid>                 查看待办
  node src/cli.js owner                           查看「按内容推断负责人」的对照表
        要改这张表：在 data/owner-rules.json 写
          [ { "keywords": ["学籍", "交助辅"], "role": "副班长" } ]
        不写这个文件就用内置默认表；关键词用「包含」匹配。
  node src/cli.js add <群openid> <标题> [截止日]   手动加一条
  node src/cli.js todo done <群openid> <关键词>    销项（做完了）
  node src/cli.js todo drop <关键词>              作废（不用管了，如过期通知）
  node src/cli.js todo autoclose                  立刻跑一次自动销项（过截止日的归档）
  node src/cli.js preview                         预览三种推送的实际样子
  node src/cli.js weekly <群openid>               立刻推一次周报（周六 08:00 跑的就是它）
  node src/cli.js digest <群openid>               立刻执行一次日报推送
  node src/cli.js remind <群openid>               立刻执行一次到期提醒

  node src/cli.js course list                     查看课程表
  node src/cli.js course add <名称> <开课时间> [截止时间]
        例：course add "高等数学" "每周三 08:00" "每周日 23:59"
        例：course add "英语听力" "2026-11-05 08:00" "2026-11-12 23:59"
  node src/cli.js course rm <名称>                删除课程
  node src/cli.js course import <文件>            从文本文件批量导入（一行一门课）
        文件格式（用 | 分隔，后两列可省略）：
          高等数学 | 每周三 08:00 | 每周日 23:59
          大学英语 | 每周一 10:00
          形势与政策 | 11月5日 14:30 | 11月5日 16:00
  node src/cli.js course import -                 从标准输入读取，粘贴后按 Ctrl+D
  node src/cli.js course test                     立刻跑一次扫描，看有没有命中
  node src/cli.js course ping [群openid]          往群里发一条测试消息，验证能收到

  node src/cli.js replay [日期] [群openid]        用存档的真实群消息重放抽取，看规则认不认
        --save 把认出来的直接入库（默认只看不写）
        存档在 data/messages/<日期>.jsonl，只保留最近 7 天
  node src/cli.js backup                          立刻做一份数据快照
  node src/cli.js backup list                     看现有的快照
  node src/cli.js backup restore [文件名]          恢复快照（不填用最新一份），恢复后要重启服务
`);
}

function formatSpec(spec) {
  if (!spec) return '未设置';
  const days = ['', '一', '二', '三', '四', '五', '六', '日'];
  if (spec.repeat === 'weekly') return `每周${days[spec.weekday]} ${spec.time}`;
  return `${spec.date} ${spec.time}`;
}


/** 录入后检查提醒会不会落进静默时段，落了就等于不会发 */
function reportQuietRisk(courses) {
  const lines = [];
  for (const c of courses) {
    for (const r of quietRisk(c)) {
      const hh = String(r.sendAt.getHours()).padStart(2, '0');
      const mm = String(r.sendAt.getMinutes()).padStart(2, '0');
      lines.push(
        `  ${c.name} 的${r.kind}提醒应在 ${hh}:${mm} 发出，落在静默时段（${config.quietStart}-${config.quietEnd} 点）`
      );
    }
  }
  if (!lines.length) return;
  console.log('\n注意：以下提醒会落进静默时段，到点不会发：');
  lines.forEach((l) => console.log(l));
  console.log('  建议把提前分钟数调大，让提醒落在白天。');
}

function courseList() {
  const list = listCourses();
  if (!list.length) {
    console.log('课程表为空。添加示例：');
    console.log('  node src/cli.js course add "高等数学" "每周三 08:00" "每周日 23:59"');
    return;
  }
  list.forEach((c, i) => {
    console.log(`\n${i + 1}. ${c.name}${c.enabled ? '' : '（已停用）'}`);
    if (c.open) {
      console.log(`   开课：${formatSpec(c.open)}，提前 ${c.advanceOpenMin} 分钟提醒`);
    }
    if (c.close) {
      console.log(`   截止：${formatSpec(c.close)}，提前 ${c.advanceCloseMin} 分钟提醒`);
    }
    const next = previewCourse(c, 2).slice(0, 2);
    if (next.length) {
      console.log(`   接下来：${next.map((r) => `${r.kind} ${r.at}`).join(' / ')}`);
    }
  });
  console.log('');
}

async function main() {
  switch (cmd) {
    case 'doctor': {
      const okLine = (s) => console.log(`  [OK]   ${s}`);
      const bidLine = (s) => console.log(`  [!!]   ${s}`);
      const noteLine = (s) => console.log(`         ${s}`);

      console.log('\n运行环境');
      okLine(`Node ${process.version}`);
      noteLine(`工作目录 ${process.cwd()}`);
      noteLine(`数据目录 ${config.dataDir}`);

      console.log('\n依赖');
      for (const dep of ['node-cron', 'ws', 'dotenv']) {
        const p = path.join(ROOT_DIR, 'node_modules', dep);
        if (fs.existsSync(p)) okLine(dep);
        else noteLine(`${dep} 未安装（可忽略，只要程序能启动）`);
      }

      console.log('\n凭据');
      if (config.appId && config.appSecret) {
        okLine(`AppID ${config.appId}`);
        noteLine('AppSecret 已填写（不显示内容）');
      } else {
        bidLine('缺少 QQ_APP_ID 或 QQ_APP_SECRET，检查 .env');
      }
      if (config.llm.apiKey) okLine('已配置大模型，走模型抽取');
      else okLine('未配置 LLM_API_KEY，走规则抽取（免费）');

      console.log('\n群与数据');
      const groups = listGroups();
      if (groups.length) {
        for (const g of groups) okLine(`已登记群 ${g.openid}${g.name ? `（${g.name}）` : ''}`);
      } else {
        bidLine('还没有登记任何群');
        noteLine('把机器人拉进群，@ 它发一句「群ID」，登记之后才会自动推送');
      }
      const allGroups = knownGroups();
      let total = 0;
      for (const g of allGroups) {
        const n = listTodos(g, { status: 'open' }).length;
        total += n;
        noteLine(`${g}：${n} 条进行中`);
      }
      if (!allGroups.length) noteLine('待办库是空的');
      else noteLine(`合计 ${total} 条进行中`);

      console.log('\n推送计划');
      noteLine(`时区 ${config.timezone}`);
      noteLine(
        `周报 ${config.digestCron}${config.weeklyOnly ? '（只放行每月 1-28 号，保证每月正好 4 次）' : ''}`
      );
      noteLine(`到期提醒 ${config.remindCron || '已关闭'}`);
      noteLine(`课程主动提醒 ${config.coursePush ? '开启' : '已关闭'}`);
      noteLine(
        `无截止日退场：日期待定 ${config.pendingShowLimit} 次、无期限 ${config.ongoingShowLimit} 次`
      );
      noteLine(`群消息模式 ${config.fullMessageMode ? '全量（需要后台开启「接收所有消息」）' : '仅 @ 机器人'}`);

      console.log('\n下一步');
      if (!groups.length) {
        console.log('  1. 确认机器人已进群，并在 q.qq.com 后台把事件订阅方式设成 WebSocket');
        console.log('  2. 群里 @ 它发「群ID」，看到回复就说明链路通了');
        console.log('  3. 再跑一次 node src/cli.js doctor 确认群已登记');
      } else {
        console.log('  node src/cli.js weekly <群openid>   手动推一次周报，验证能不能发出去');
      }
      console.log('');
      break;
    }
    case 'groups': {
      const found = listGroups();
      const inTodos = knownGroups();

      if (!found.length && !inTodos.length) {
        console.log('还没有已知群。把机器人拉进群 @ 它一次就会自动登记。');
        break;
      }

      if (found.length) {
        console.log('机器人已自动登记的群（这些会收到主动推送）：');
        for (const g of found) {
          const st = groupStats(g.openid);
          const last = g.last_seen.slice(0, 16).replace('T', ' ');
          console.log(
            `  ${g.openid}  ${g.name || '（未命名）'}  待办 ${st.total} 项  最近活跃 ${last}`
          );
        }
      }

      const onlyInTodos = inTodos.filter((g) => !found.some((f) => f.openid === g));
      if (onlyInTodos.length) {
        console.log('\n只出现在待办库里的群名（机器人还没在群里收到过消息）：');
        for (const g of onlyInTodos) {
          console.log(`  ${g}  待办 ${groupStats(g).total} 项`);
        }
      }

      console.log(`\n实际推送目标：${resolveTargets().join(', ') || '（空）'}`);
      break;
    }
    case 'group': {
      const sub = args[0];
      if (sub === 'forget') {
        const [openid] = args.slice(1);
        if (!openid) return usage();
        console.log(removeGroup(openid) ? `已从登记簿移除 ${openid}` : `登记簿里没有 ${openid}`);
        return;
      }
      return usage();
    }
    case 'list': {
      const [group] = args;
      if (!group) return usage();
      const todos = listTodos(group, { status: 'open' });
      console.log(renderSummary(todos));
      // 明细里把「负责人是写明的还是系统猜的」标出来，避免把推断当成事实
      const detail = todos.map((t, i) => {
        const who = t.owner
          ? `${t.owner}${t.owner_inferred ? '（推断）' : ''}`
          : '全体';
        const when = t.due
          ? `${t.due}${t.due_time ? ' ' + t.due_time : ''}`
          : t.time_state === 'ongoing'
            ? '无期限'
            : '待定';
        return `${i + 1}. ${t.title}  〔${who}〕  ${when}`;
      });
      if (detail.length) console.log('\n' + detail.join('\n'));
      console.log('\n统计：', JSON.stringify(groupStats(group)));
      break;
    }
    case 'owner': {
      const { ownerRules, ownerRulesPath } = await import('./features/owner-rules.js');
      const rules = ownerRules();
      console.log('按内容推断负责人的对照表（只在通知里没写任何人时才会用到）：\n');
      for (const r of rules) {
        console.log(`  ${r.role.padEnd(5, '　')} ← ${r.keywords.join('、')}`);
      }
      console.log(`\n共 ${rules.length} 条。自定义表：${ownerRulesPath()}`);
      console.log('表里没有的，一律算全体。宁可不猜，也不把人挂错。');
      break;
    }
    case 'add': {
      const [group, title, dueRaw] = args;
      if (!group || !title) return usage();
      const due = dueRaw ? parseDueDate(dueRaw) ?? (dueRaw.match(/^\d{4}-\d{2}-\d{2}$/) ? dueRaw : null) : null;
      const { todo, duplicated } = addTodo({
        group,
        title,
        due,
        source: 'cli',
      });
      console.log(duplicated ? `已存在：${todo.title}` : `已添加：${todo.title}${due ? ` 截止 ${due}` : ''}`);
      break;
    }
    case 'weekly': {
      assertConfig();
      const [group] = args;
      if (!group) return usage();
      const r = await pushWeekly(group, { force: true });
      console.log(r);
      break;
    }
    case 'digest': {
      assertConfig();
      const [group] = args;
      if (!group) return usage();
      const r = await pushDigest(group);
      console.log(r);
      break;
    }
    case 'remind': {
      assertConfig();
      const [group] = args;
      if (!group) return usage();
      const r = await pushReminder(group);
      console.log(r);
      break;
    }
    case 'preview': {
      const t = today();
      // 用班级群的真实场景做样例：有全体的事，也有只归某个班委的事，
      // 还有两条没有截止日的（日期待定 / 无期限），一眼能看出差别
      const demo = [
        { title: '交线代作业2.5', due: addDays(t, -2) },
        { title: '学风建设先进个人申报（附件5）', due: t, due_time: '12:00' },
        {
          title: '知网杯检索大赛答题',
          owner: '纪检委员',
          due_start: addDays(t, 4),
          due: addDays(t, 22),
        },
        { title: '学籍信息核对材料汇总', owner: '副班长', due: addDays(t, 3), due_time: '14:00' },
        { title: '高数答疑课（教4-102）', due: addDays(t, 8), due_time: '18:30' },
        { title: '机械制图的实验课', due: null, time_state: 'pending' },
        { title: '看 CAD 回放', due: null, time_state: 'ongoing' },
      ].map((x, i) => ({ id: String(i), status: 'open', owner: '', ...x }));

      const sep = (n) => `\n${'='.repeat(24)} ${n} ${'='.repeat(24)}\n`;

      console.log(sep('1. 群里 @ 机器人（条目多时分组）'));
      const summary = renderSummary(demo);
      console.log(summary);
      console.log(
        `\n（${summary.length} 字，分 ${splitMessage(summary, { maxChunks: 5 }).length} 条发送；已逾期的 1 项被隐藏）`
      );

      console.log(sep('2. 条目少时自动平铺'));
      console.log(renderSummary(demo.slice(1, 4)));

      console.log(sep('3. 每天 18:00 的日报'));
      const digest = renderDigest(demo);
      console.log(digest);
      console.log(
        `\n（${digest.length} 字，分 ${splitMessage(digest, { maxChunks: 3 }).length} 条发送）`
      );

      console.log(sep('4. 到期提醒（今天/明天，开始与到期都提醒）'));
      console.log(
        renderReminderGroups([
          {
            label: '明天开始',
            items: [
              { title: '知网杯检索大赛答题', owner: '纪检委员', due_start: addDays(t, 1), due: addDays(t, 20) },
            ],
          },
          { label: '明天到期', items: [{ title: '交线代作业2.5' }] },
        ])
      );

      console.log(sep('5. 周六 08:00 的周报'));
      const live = demo.filter((x) => (x.due ? x.due >= t : true));
      console.log(renderWeekly(pickWeeklyBuckets(live, t)).text);
      console.log('');
      break;
    }
    case 'replay': {
      // 用存档里的真实语料重放抽取，看规则到底认不认。
      // 存在的理由：规则是「宁可漏不肯错」的，但漏掉的必须能查。
      // 以前只能拿日志前 40 字去猜，改正则等于蒙；现在有原文就能一条条核对。
      const flags = args.filter((a) => a.startsWith('--'));
      const rest = args.filter((a) => !a.startsWith('--'));
      const save = flags.includes('--save');

      const dayArg = rest.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || today();
      const groupArg = rest.find((a) => a !== dayArg) || '';

      const { readMessages } = await import('./store/messages.js');
      const { inferTodoByRules } = await import('./features/extract.js');
      const { parseBaseDate } = await import('./utils/date.js');

      let msgs = readMessages(dayArg);
      if (!msgs.length) {
        console.log(`${dayArg} 没有消息存档。`);
        console.log('存档从这次升级之后才开始写；更早的消息平台不提供拉取接口，补不回来。');
        break;
      }
      if (groupArg) msgs = msgs.filter((m) => m.group === groupArg);

      let ok = 0;
      let saved = 0;
      const misses = [];
      for (const m of msgs) {
        const base = parseBaseDate(m.ts);
        const diagnose = {};
        const r = inferTodoByRules(m.content, { mentions: [], base, diagnose });
        const brief = String(m.content || '')
          .replace(/\s+/g, ' ')
          .slice(0, 28);
        if (r) {
          ok += 1;
          console.log(`✓ ${brief}…`);
          console.log(
            `   标题：${r.title}\n   负责人：${r.owner || '全体'}${
              r.ownerInferred ? '（推断）' : ''
            }   截止：${r.due || (r.timeState === 'ongoing' ? '无期限' : '待定')}${
              r.dueTime ? ' ' + r.dueTime : ''
            }`
          );
          if (save) {
            const { todo, duplicated } = addTodo({
              group: m.group,
              title: r.title,
              owner: r.owner,
              ownerInferred: r.ownerInferred,
              due: r.due,
              dueStart: r.dueStart,
              dueTime: r.dueTime,
              timeState: r.timeState,
              sourceMsgId: m.id,
              sourceText: m.content,
              source: 'rule',
            });
            if (!duplicated) {
              saved += 1;
              console.log(`   已入库 #${todo.id}`);
            } else {
              console.log('   库里已有同名待办，跳过');
            }
          }
        } else {
          misses.push({ brief, reason: diagnose.reason || '未知' });
          console.log(`✗ ${brief}…`);
          console.log(`   ${diagnose.reason || '未知'}`);
        }
      }

      console.log(
        `\n${dayArg}：共 ${msgs.length} 条，认出 ${ok} 条，未认出 ${misses.length} 条` +
          (save ? `，新入库 ${saved} 条` : '')
      );
      if (misses.length) {
        // 按原因归类，一眼看出该改哪一块：是噪声太宽、还是动作词太少
        const byReason = new Map();
        for (const x of misses) {
          const key = x.reason.replace(/[（(].*$/, '').trim();
          byReason.set(key, (byReason.get(key) || 0) + 1);
        }
        console.log('\n未认出的原因分布：');
        for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${v} 条  ${k}`);
        }
        console.log('\n要补进去：node src/cli.js replay ' + dayArg + ' --save');
      }
      break;
    }
    case 'backup': {
      const sub = args[0] || 'now';
      if (sub === 'list' || sub === 'ls') {
        const all = listBackups();
        if (!all.length) {
          console.log('还没有任何快照，跑一次 `node src/cli.js backup` 就有了。');
          break;
        }
        console.log(`共 ${all.length} 份快照（最新在最后）：`);
        all.forEach((f) => console.log(`  ${f}`));
        break;
      }
      if (sub === 'restore') {
        const r = restoreBackup(args[1]);
        console.log(`已从 ${r.createdAt} 的快照恢复：${r.restored.join('、')}`);
        console.log('重启服务后生效：systemctl restart qqbot-class-assistant');
        break;
      }
      const r = runBackup();
      if (r.empty) {
        console.log(`数据目录里没有可备份的文件：${config.dataDir}`);
        break;
      }
      console.log(`已生成 ${r.file}（${Math.round(r.size / 1024)}KB）`);
      if (r.removed) console.log(`清理了 ${r.removed} 份过期快照`);
      console.log(`当前共 ${listBackups().length} 份`);
      break;
    }
    case 'todo': {
      const sub = args[0];
      if (sub === 'done' || sub === 'rm' || sub === 'drop') {
        // 用法：todo done|drop <群> <关键词>，或者只给关键词时在全部群里找
        // done = 做完了；drop = 不用管了（过期通知、作废安排）
        const dropped = sub === 'drop';
        let group = args[1];
        let keyword = args[2];
        if (!keyword) {
          keyword = group;
          group = null;
        }
        if (!keyword) return usage();

        const scope = group ? [group] : knownGroups();
        const hits = [];
        for (const g of scope) hits.push(...findByKeyword(g, keyword));

        if (!hits.length) {
          console.log(`没有匹配「${keyword}」的进行中待办`);
          return;
        }
        for (const t of hits) {
          updateTodo(t.id, {
            status: dropped ? 'dropped' : 'done',
            [dropped ? 'dropped_at' : 'done_at']: new Date().toISOString(),
          });
          console.log(
            `${dropped ? '已作废' : '已销项'}：${t.title}${t.due ? `（原截止 ${t.due}）` : ''}`
          );
        }
        return;
      }
      if (sub === 'autoclose' || sub === 'auto') {
        const n = autoCloseOverdue();
        console.log(
          n ? `已自动销项 ${n} 条（截止日已过）` : '没有需要自动销项的待办'
        );
        return;
      }
      if (sub === 'move') {
        const [from, to] = args.slice(1);
        if (!from || !to) return usage();
        const n = moveGroup(from, to);
        console.log(n ? `已把 ${n} 条待办从「${from}」迁到「${to}」` : `「${from}」下没有待办`);
        return;
      }
      if (sub === 'import') {
        const src = args[1];
        const group = args[2] || 'pending';
        if (!src) return usage();

        let text;
        if (src === '-') {
          text = fs.readFileSync(0, 'utf8');
        } else {
          const file = path.resolve(process.cwd(), src);
          if (!fs.existsSync(file)) {
            console.log(`文件不存在：${file}`);
            return;
          }
          text = fs.readFileSync(file, 'utf8');
        }

        const added = [];
        const skipped = [];
        const lines = String(text)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));

        for (const line of lines) {
          const cols = line.split(/\s*[|\t]\s*/).map((x) => x.trim());
          const title = cols[0];
          if (!title) continue;
          const dueText = cols[1] || '';
          // 第三列写负责人，第四列写「无期限 / 待定」。
          // 只写两列时行为跟以前一样，老文件不用改。
          const ownerText = cols[2] || '';
          const stateText = cols[3] || '';
          const due = parseDueDate(dueText);
          const dueTime = parseTime(dueText);
          // 「全班 / 全体」不是负责人，是默认值——写进 owner 会让周报每条都挂个〔全班〕
          const owner = /^(全班|全体|大家|所有人|全员|全班同学)$/.test(ownerText)
            ? ''
            : ownerText;
          let timeState = due ? 'dated' : 'pending';
          if (/无期限|长期|长期有效|ongoing/i.test(stateText)) timeState = 'ongoing';
          else if (/待定|待通知|pending/i.test(stateText)) timeState = 'pending';
          const { todo, duplicated } = addTodo({
            group,
            title,
            owner,
            due,
            dueTime,
            timeState,
            source: 'manual',
          });
          if (duplicated) skipped.push(title);
          else added.push(todo);
        }

        if (added.length) {
          console.log(`导入 ${added.length} 条待办到「${group}」：`);
          for (const t of added) {
            const dueText = t.due ? `${t.due}${t.due_time ? ' ' + t.due_time : ''}` : '无截止';
            console.log(`  ${t.title}  →  ${dueText}`);
          }
        }
        if (skipped.length) {
          console.log(`\n跳过 ${skipped.length} 条（同名同截止已存在）：${skipped.join('、')}`);
        }
        if (!added.length && !skipped.length) {
          console.log('文件里没有可导入的内容（空行和 # 开头的注释会被忽略）。');
        } else if (group === 'pending') {
          console.log('\n现在存在占位群 pending 下。机器人第一次在真实群里收到消息时会自动认领，');
          console.log('不用手动搬；想指定群就执行：npm run cli -- todo move pending <群openid>');
        }
        return;
      }
      return usage();
    }
    case 'course': {
      const sub = args[0];
      if (sub === 'list' || !sub) return courseList();
      if (sub === 'rm' || sub === 'remove') {
        const [keyword] = args.slice(1);
        if (!keyword) return usage();
        const removed = removeCourse(keyword);
        console.log(removed ? `已删除：${removed.name}` : `没有找到「${keyword}」`);
        return;
      }
      if (sub === 'add') {
        const [name, openText, closeText] = args.slice(1);
        if (!name) return usage();
        const blank = (v) => !v || v === '-' || v === '无';

        let open = null;
        if (!blank(openText)) {
          open = parseScheduleSpec(openText);
          if (!open) {
            console.log(
              `无法识别开课时间「${openText}」。支持：每周三 08:00 / 11月5日 14:30 / 2026-11-05 08:00`
            );
            return;
          }
        }

        let close = null;
        if (!blank(closeText)) {
          close = parseScheduleSpec(closeText);
          if (!close) {
            console.log(`无法识别截止时间「${closeText}」`);
            return;
          }
        }

        if (!open && !close) {
          console.log('开课和截止至少要填一个。');
          console.log('  只有开课：course add "高等数学" "每周三 08:00"');
          console.log('  只有截止：course add "新中国史第五章" - "11月15日 11:59"');
          return;
        }

        const course = addCourse({ name, open, close });
        console.log(`已添加：${course.name}`);
        if (course.open) {
          console.log(`  开课 ${formatSpec(course.open)}，提前 ${course.advanceOpenMin} 分钟提醒`);
        }
        if (course.close) {
          console.log(
            `  截止 ${formatSpec(course.close)}，提前 ${course.advanceCloseMin} 分钟提醒`
          );
        }
        const next = previewCourse(course, 2);
        if (next.length) console.log(`  接下来：${next.map((r) => `${r.kind} ${r.at}`).join(' / ')}`);
        reportQuietRisk([course]);
        return;
      }
      if (sub === 'import') {
        const src = args[1];
        if (!src) return usage();
        let text;
        if (src === '-') {
          text = fs.readFileSync(0, 'utf8');
        } else {
          const file = path.resolve(process.cwd(), src);
          if (!fs.existsSync(file)) {
            console.log(`文件不存在：${file}`);
            return;
          }
          text = fs.readFileSync(file, 'utf8');
        }

        const { added, failed, skipped } = importCourses(text);
        if (added.length) {
          console.log(`导入成功 ${added.length} 门：`);
          for (const c of added) {
            const openPart = c.open
              ? `开课 ${formatSpec(c.open)}（提前 ${c.advanceOpenMin} 分钟提醒）`
              : '仅截止提醒';
            const closeText = c.close
              ? ` → 截止 ${formatSpec(c.close)}（提前 ${c.advanceCloseMin} 分钟提醒）`
              : '';
            console.log(`  ${c.name}  ${openPart}${closeText}`);
          }
        }
        if (skipped.length) {
          console.log(`\n跳过 ${skipped.length} 门（同名同时间已存在）：${skipped.join('、')}`);
        }
        if (failed.length) {
          console.log(`\n有 ${failed.length} 行没看懂：`);
          for (const f of failed) console.log(`  ${f.line}\n    → ${f.reason}`);
          console.log(
            '  时间写法支持：每周三 08:00 / 周三 08:00 / 11月5日 14:30 / 2026-11-05 08:00'
          );
          console.log('  只有截止时间时，开课那一列写 - 占位，例如：新中国史第五章 | - | 11月15日 11:59');
        }
        if (added.length) reportQuietRisk(added);
        if (!added.length && !failed.length && !skipped.length) {
          console.log('文件里没有可导入的内容（空行和 # 开头的注释会被忽略）。');
        } else if (added.length) {
          console.log('\n用 course list 核对，或 course test 演练一次提醒。');
        }
        return;
      }
      if (sub === 'test') {
        const sent = [];
        const hits = await scanCourses(new Date(), {
          dryRun: true,
          sender: async (group, text) => {
            sent.push({ group, text });
          },
        });
        if (!sent.length) {
          console.log('此刻没有需要发出的提醒。');
          console.log('（演练模式，不会真的发消息，也不会影响下一次正常提醒。）');
          if (!hits.length) {
            console.log('提示：提醒时间按「课程开始/截止时间减去提前分钟数」计算，');
            console.log('      比如开课 08:00、提前 30 分钟，就是 07:30 那一分钟发出。');
          }
          return;
        }
        console.log(`演练：此刻会发出 ${sent.length} 条消息（未实际发送）\n`);
        for (const s of sent) {
          console.log(`→ 群 ${s.group}`);
          console.log(s.text);
          console.log('');
        }
        return;
      }
      if (sub === 'ping') {
        const target = args[1] || config.groupOpenids[0];
        if (!target) {
          console.log('请指定群 openid，或在 .env 里配置 QQ_GROUP_OPENIDS。');
          return;
        }
        try {
          await sendGroupMessage(
            target,
            '【测试】课程提醒已接通。开课前会提前提醒，课程关闭前也会提醒一次。'
          );
          console.log(`已发送到群 ${target}，去群里看有没有收到。`);
          console.log('没收到的话，先查群成员是否关闭了「允许机器人主动发送消息」。');
        } catch (err) {
          console.log(`发送失败：${err.message}`);
        }
        return;
      }
      return usage();
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error('执行失败：', err.message);
  process.exit(1);
});
