import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * 记录每个群最后一次成功推送周报的日期。
 *
 * 存在的理由：QQ 主动消息每个群每个自然月只有 4 条。
 * 月中手动补发一次（或运维验证发了一条）之后，如果周六照发不误，
 * 这个月就会变成 5 条，最后一条必然被平台拒绝——
 * 用户要的是「每月正好用满 4 次」，多一条反而拿不到。
 * 有了这个记录，同一自然周只发一次，手动发过的那周周六自动跳过。
 */
const FILE = () =>
  path.join(config.dataDir, 'push-state.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return {};
  }
}

function write(obj) {
  const f = FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

/** 该群最后一次成功推送周报的日期（YYYY-MM-DD），没有则返回 null */
export function lastWeeklyDate(group) {
  const v = read().weekly?.[group];
  return typeof v === 'string' && v ? v : null;
}

export function markWeeklySent(group, isoDate) {
  const s = read();
  if (!s.weekly) s.weekly = {};
  s.weekly[group] = isoDate;
  // 顺手记一份历史，出问题时能看出这个月到底发了几条
  s.history = Array.isArray(s.history) ? s.history : [];
  s.history.push({ group, date: isoDate, at: new Date().toISOString() });
  if (s.history.length > 200) s.history = s.history.slice(-200);
  write(s);
}
