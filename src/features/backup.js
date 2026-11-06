/**
 * 数据快照。
 *
 * 只做「同机快照」，用途是防止机器人自己把数据写坏（比如某次解析异常把
 * todos.json 覆盖成空库）。它不能替代异地备份：机器到期释放、磁盘损坏时
 * 同机快照会一起没掉。异地备份定期 scp 一份到本地即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';

/** 需要纳入快照的数据文件 */
const FILES = ['todos.json', 'courses.json', 'groups.json'];

const KEY = 'data';

const backupDir = () => path.join(config.dataDir, '_backups');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 按时间正序返回快照文件名 */
export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${KEY}-`) && f.endsWith('.json'))
    .sort();
}

function prune(keep) {
  const all = listBackups();
  const drop = all.slice(0, Math.max(0, all.length - keep));
  for (const f of drop) {
    try {
      fs.unlinkSync(path.join(backupDir(), f));
    } catch (err) {
      log.error(`删除旧快照失败 ${f}: ${err.message}`);
    }
  }
  return drop.length;
}

/**
 * 立刻生成一份快照。
 * 所有数据文件合并成一个 JSON，恢复时一次写回，不依赖 tar。
 */
export function runBackup({ keep = config.backupKeep } = {}) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });

  const payload = {
    version: 1,
    created_at: new Date().toISOString(),
    files: {},
  };

  let count = 0;
  for (const name of FILES) {
    const src = path.join(config.dataDir, name);
    if (!fs.existsSync(src)) continue;
    const raw = fs.readFileSync(src, 'utf8');
    try {
      payload.files[name] = JSON.parse(raw);
    } catch {
      // 文件已损坏时按原文存，至少还能人工翻查
      payload.files[name] = raw;
    }
    count += 1;
  }

  if (!count) return { file: null, removed: 0, empty: true };

  const file = path.join(dir, `${KEY}-${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  const removed = Number.isFinite(keep) && keep > 0 ? prune(keep) : 0;
  return { file, removed, empty: false, size: fs.statSync(file).size };
}

/** 恢复指定快照；不传则用最新一份。返回被覆盖的文件名数组 */
export function restoreBackup(nameOrPath) {
  const dir = backupDir();
  let target = nameOrPath;
  if (!target) {
    const all = listBackups();
    if (!all.length) throw new Error('还没有任何快照，先跑一次备份');
    target = path.join(dir, all[all.length - 1]);
  } else if (!path.isAbsolute(target)) {
    const inDir = path.join(dir, target);
    target = fs.existsSync(inDir) ? inDir : path.resolve(target);
  }
  if (!fs.existsSync(target)) throw new Error(`快照不存在：${target}`);

  const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
  const files = payload.files || {};
  const restored = [];

  for (const [name, content] of Object.entries(files)) {
    const dest = path.join(config.dataDir, name);
    fs.mkdirSync(config.dataDir, { recursive: true });
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(dest, text, 'utf8');
    restored.push(name);
  }
  if (!restored.length) throw new Error('这份快照里没有数据文件');
  return { restored, createdAt: payload.created_at || '未知' };
}
