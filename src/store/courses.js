import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { CN_WEEKDAY, parseDueDate, parseTime } from '../utils/date.js';
import { migrate, SCHEMA_VERSION } from './schema.js';

const FILE = () => path.join(config.dataDir, 'courses.json');

let cache = null;

function emptyState() {
  return { version: SCHEMA_VERSION, courses: [] };
}

function load() {
  if (cache) return cache;
  const file = FILE();
  if (!fs.existsSync(file)) {
    cache = emptyState();
    return cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.error(`读取课程表失败，将以空表启动：${err.message}`);
    cache = emptyState();
    return cache;
  }

  // 版本比程序新时这里会抛，故意不兜：宁可起不来，也别把课程写没
  const data = migrate(parsed, file);
  cache = { version: SCHEMA_VERSION, courses: Array.isArray(data.courses) ? data.courses : [] };
  return cache;
}

function save() {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 解析一个时间规则：
 *   "每周三 08:00"      -> { repeat: 'weekly', weekday: 3, time: '08:00' }
 *   "11月5日 14:30"     -> { date: '2026-11-05', time: '14:30' }
 *   "2026-11-05 14:30"  -> { date: '2026-11-05', time: '14:30' }
 */
export function parseScheduleSpec(text) {
  if (!text) return null;
  const t = String(text).trim();
  const time = parseTime(t) || '00:00';

  const weekly = t.match(/(?:每|每个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
  if (weekly) {
    return { repeat: 'weekly', weekday: CN_WEEKDAY[weekly[1]], time };
  }

  const date = parseDueDate(t);
  if (date) return { date, time };

  return null;
}

export function addCourse({
  name,
  open = null,
  close = null,
  advanceOpenMin = 30,
  advanceCloseMin = 120,
  target = '',
}) {
  const state = load();
  const course = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    open,
    close,
    advanceOpenMin: Number(advanceOpenMin) || 0,
    advanceCloseMin: Number(advanceCloseMin) || 0,
    target: target || '',
    enabled: true,
    last: {},
    created_at: new Date().toISOString(),
  };
  state.courses.push(course);
  save();
  return course;
}

export function listCourses({ enabledOnly = false } = {}) {
  const list = load().courses;
  return enabledOnly ? list.filter((c) => c.enabled) : list;
}

export function removeCourse(keyword) {
  const state = load();
  const k = String(keyword).trim();
  const idx = state.courses.findIndex((c) => c.name.includes(k) || c.id === k);
  if (idx === -1) return null;
  const [removed] = state.courses.splice(idx, 1);
  save();
  return removed;
}

export function recordNotified(id, kind, iso) {
  recordNotifiedMany([{ id, kind, iso }]);
}

/** 一次性记录多条，避免每门课都写一遍文件 */
export function recordNotifiedMany(entries) {
  if (!entries.length) return;
  const state = load();
  let touched = false;
  for (const { id, kind, iso } of entries) {
    const course = state.courses.find((c) => c.id === id);
    if (!course) continue;
    course.last = course.last || {};
    course.last[kind] = iso;
    touched = true;
  }
  if (touched) save();
}

/**
 * 判断两个时间规则是不是同一场次。
 * 周期规则比「星期几 + 时刻」，一次性规则比「日期 + 时刻」，两个都为空视为相同。
 */
function sameTimeSpec(a, b) {
  if (!a || !b) return !a && !b;
  if (a.time !== b.time) return false;
  if (a.repeat === 'weekly' && b.repeat === 'weekly') return a.weekday === b.weekday;
  if (a.date && b.date) return a.date === b.date;
  return false;
}

/** Excel 里常出现的空占位写法都当作「没有这个时间」 */
function isBlankCell(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  return s === '' || s === '-' || s === '—' || s === '无' || s === '/';
}

/**
 * 批量导入课表。每行一门课，字段用 | 、Tab 或逗号分隔：
 *   高等数学 | 每周三 08:00 | 每周日 23:59
 *   大学英语 | 每周一 10:00
 *   新中国史第五章 | - | 11月15日 11:59     ← 只有截止，开课留空写 -
 *   形势与政策 | 11月5日 14:30 | 11月5日 16:00
 * 第 4、5 列可选，分别是开课提前分钟数、截止提前分钟数。
 * 以 # 开头的行视为注释。
 */
export function importCourses(text) {
  const added = [];
  const failed = [];
  const skipped = [];

  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  for (const line of lines) {
    // 先按 | 或 Tab 切；切不出来再按逗号切。保留空列，否则「- | 时间」会错位。
    let cols = line.split(/\s*[|\t]\s*/).map((s) => s.trim());
    if (cols.length < 2) cols = line.split(/\s*[,，]\s*/).map((s) => s.trim());

    const name = cols[0];
    if (!name) continue;

    let open = null;
    if (!isBlankCell(cols[1])) {
      open = parseScheduleSpec(cols[1]);
      if (!open) {
        failed.push({ line, reason: `看不懂开课时间「${cols[1]}」` });
        continue;
      }
    }

    let close = null;
    if (!isBlankCell(cols[2])) {
      close = parseScheduleSpec(cols[2]);
      if (!close) {
        failed.push({ line, reason: `看不懂截止时间「${cols[2]}」` });
        continue;
      }
    }

    if (!open && !close) {
      failed.push({ line, reason: '开课和截止都没有填' });
      continue;
    }

    // 同名 + 同时间规则才算重复，避免反复导入堆重复项；
    // 但同一门课的不同场次（比如两次形势与政策讲座）应当分别入库。
    if (
      load().courses.some(
        (c) => c.name === name && sameTimeSpec(c.open, open) && sameTimeSpec(c.close, close)
      )
    ) {
      skipped.push(name);
      continue;
    }

    const advanceOpenMin = cols[3] !== undefined ? Number(cols[3]) : 30;
    const advanceCloseMin = cols[4] !== undefined ? Number(cols[4]) : 120;

    added.push(
      addCourse({
        name,
        open,
        close,
        advanceOpenMin: Number.isFinite(advanceOpenMin) ? advanceOpenMin : 30,
        advanceCloseMin: Number.isFinite(advanceCloseMin) ? advanceCloseMin : 120,
      })
    );
  }

  return { added, failed, skipped };
}
