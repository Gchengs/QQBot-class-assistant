import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadEnvFile();

function get(key, fallback = '') {
  const v = process.env[key];
  if (v !== undefined && v !== '') return v;
  const f = fileEnv[key];
  if (f !== undefined && f !== '') return f;
  return fallback;
}

function getBool(key, fallback) {
  const v = get(key, '');
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

// 先单独算出来，因为下面存档开关要拿它当默认值（见 ARCHIVE_GROUP_MESSAGES）
const logGroupMessages = getBool('LOG_GROUP_MESSAGES', true);

export const config = {
  appId: get('QQ_APP_ID'),
  // 机器人自己的 openid。留空则启动后调 /users/@me 取一次
  botOpenid: get('BOT_OPENID', ''),
  appSecret: get('QQ_APP_SECRET'),
  groupOpenids: get('QQ_GROUP_OPENIDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  fullMessageMode: getBool('FULL_MESSAGE_MODE', true),
  // 周报：默认每周六 08:00。QQ 主动消息每群每月只有 4 条左右，
  // 每天推会立刻烧完配额，所以默认改成一周一次。
  digestCron: get('DIGEST_CRON', '0 8 * * 6'),
  // 每月配额只有 4 条，而有的月份有 5 个周六。
  // 开启后只在本月前 4 个周六推送，第 5 个自动跳过，保证每自然月恰好 4 次。
  weeklyOnly: getBool('WEEKLY_ONLY', true),
  // 留空 = 关闭到期提醒。主动消息配额太紧，默认不占用。
  remindCron: get('REMIND_CRON', ''),
  // 课程提醒走主动推送，同样吃配额，默认关闭（改成 true 会抢走周报的额度）
  coursePush: getBool('COURSE_PUSH', false),
  // 没配大模型时，用规则从群消息里抽待办（只认结构明显的，宁可漏不肯错）
  ruleExtract: getBool('RULE_EXTRACT', true),
  // 每收到一条群消息就在日志里留一行（截断 40 字），用于确认全量消息权限到底通没通。
  // 介意日志留聊天内容就设成 false。
  logGroupMessages,
  // 群消息原文存档（data/messages/<日期>.jsonl，保留 7 天），供 replay 重放抽取。
  //
  // 默认跟随 LOG_GROUP_MESSAGES，不是写死 true，这是刻意的：
  // 老用户设了 LOG_GROUP_MESSAGES=false（不想在日志里留聊天内容），
  // 升级后不能突然开始把完整原文写到磁盘上——那正好是他们关掉的意图。
  // 想单独控制就显式设 ARCHIVE_GROUP_MESSAGES。
  archiveGroupMessages: getBool('ARCHIVE_GROUP_MESSAGES', logGroupMessages),
  // 没有截止日的待办在推送里出现的次数上限，超了就静默（库里仍保留）。
  // 日期待定（等通知）：默认 3 次；无期限（长期有效）：默认 2 次。
  pendingShowLimit: Number(get('PENDING_SHOW_LIMIT', '3')),
  ongoingShowLimit: Number(get('ONGOING_SHOW_LIMIT', '2')),
  // all：推送全部进行中待办（默认）
  // urgent：只推逾期/今天/明天到期的，没有就不发
  digestMode: get('DIGEST_MODE', 'all'),
  // 自动销项：过了截止日还没人销的，归档成 expired
  autoClose: getBool('AUTO_CLOSE_OVERDUE', true),
  autoCloseCron: get('AUTO_CLOSE_CRON', '10 0 * * *'),
  // 同机数据快照，防机器人自己把数据写坏；不能替代异地备份
  backup: getBool('BACKUP_ENABLED', true),
  backupCron: get('BACKUP_CRON', '20 3 * * *'),
  backupKeep: Number(get('BACKUP_KEEP', '14')),
  llm: {
    apiKey: get('LLM_API_KEY'),
    baseUrl: get('LLM_BASE_URL', 'https://api.openai.com/v1'),
    model: get('LLM_MODEL', 'gpt-4o-mini'),
  },
  dataDir: path.resolve(ROOT, get('DATA_DIR', './data')),
  logLevel: get('LOG_LEVEL', 'info'),
  timezone: get('TZ', 'Asia/Shanghai'),
  // 静默时段：这段时间内不发任何课程提醒，避免半夜刷群。
  // 只在凌晨生效（默认 0-7 点），晚上 11 点前后学生还在线，照发。
  // 落在静默期的提醒会被跳过，录入时 CLI 会给出提示，建议调大提前量。
  quietStart: Number(get('QUIET_START_HOUR', '0')),
  quietEnd: Number(get('QUIET_END_HOUR', '7')),
};

process.env.TZ = config.timezone;

export function assertConfig() {
  const missing = [];
  if (!config.appId) missing.push('QQ_APP_ID');
  if (!config.appSecret) missing.push('QQ_APP_SECRET');
  if (missing.length) {
    throw new Error(
      `缺少必填配置：${missing.join(', ')}。请复制 .env.example 为 .env 并填写。`
    );
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
}
