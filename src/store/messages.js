import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { toISODate } from '../utils/date.js';

/**
 * 群消息原文存档。
 *
 * 为什么需要这个：抽取规则是「宁可漏也不肯错」的，但漏了必须能查。
 * 之前日志只留前 40 字，出问题时我连一条完整原文都拿不到，
 * 只能凭猜测改正则——那不叫调规则，叫蒙。
 *
 * 落盘格式是一天一个 JSONL，一行一条消息，追加写。
 * 只保留最近 7 天：够复盘，又不会把聊天记录无限期堆在磁盘上。
 *
 * 这里存的是完整聊天原文，属于敏感数据：
 * - 目录在 data/ 下，默认不进仓库（.gitignore 已挡住）
 * - 想彻底不留原文，把 LOG_GROUP_MESSAGES 设成 false，入库前就不会写
 */

const KEEP_DAYS = 7;

function dir() {
  return path.join(config.dataDir, 'messages');
}

function fileOf(isoDate) {
  return path.join(dir(), `${isoDate}.jsonl`);
}

/**
 * 追加一条消息。写失败不能影响主流程——
 * 存档是为了事后复盘，不是为了挡住消息处理。
 */
export function archiveMessage({ group, msgId, author, content, timestamp, at }) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const when = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
    const line = JSON.stringify({
      id: msgId || '',
      group: group || '',
      author: author || '',
      // 存原始发送时间，复盘时相对日期要按它换算，不能按「现在」
      ts: when.toISOString(),
      len: String(content || '').length,
      content: String(content || ''),
    });
    fs.appendFileSync(fileOf(toISODate(when)), `${line}\n`, 'utf8');
  } catch {
    /* 存档失败就算了，别影响入库 */
  }
}

/** 读某一天的全部消息，日期不存在就返回空数组 */
export function readMessages(isoDate) {
  try {
    return fs
      .readFileSync(fileOf(isoDate), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 有存档的日期列表，按时间倒序 */
export function listDays() {
  try {
    return fs
      .readdirSync(dir())
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -6))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 清掉过期存档。放在进程启动和每次写之后各跑一次，
 * 不用定时任务——多一个 timer 就多一个会悄悄死掉的东西。
 */
export function pruneOld() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const limit = toISODate(cutoff);
  let removed = 0;
  for (const day of listDays()) {
    if (day >= limit) continue;
    try {
      fs.unlinkSync(fileOf(day));
      removed += 1;
    } catch {
      /* 删不掉就留着，不值得为它报错 */
    }
  }
  return removed;
}
