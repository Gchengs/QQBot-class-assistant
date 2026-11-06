import { config } from '../config.js';
import { log } from '../logger.js';
import { listCourses, recordNotifiedMany } from '../store/courses.js';
import { resolveTargets } from '../store/groups.js';
import { sendGroupMessage } from '../qq/api.js';
import { nextWeekdayTime, atDateTime, formatDateTime } from '../utils/date.js';

// 提醒窗口：从「应发时刻」一直延伸到事件发生为止，命中一次就记录。
// 这样即使进程中途重启、或撞上静默时段，只要事件还没开始就会补发，不会丢提醒。
// 已经过去的提醒不再补发（diffMin <= 0）。

const KIND_LABEL = { open: '开课提醒', close: '截止提醒' };
const VERB = { open: '开始', close: '截止' };

/** 静默时段内不推送，避免半夜刷群 */
export function inQuietHours(d) {
  const h = d.getHours();
  const start = config.quietStart;
  const end = config.quietEnd;
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

export function computeNext(spec, base = new Date()) {
  if (!spec) return null;
  if (spec.repeat === 'weekly' && spec.weekday) {
    return nextWeekdayTime(spec.weekday, spec.time, base);
  }
  if (spec.date) {
    return atDateTime(spec.date, spec.time);
  }
  return null;
}

function remainText(minutes, { prefix = true } = {}) {
  const m = Math.max(1, Math.round(minutes));
  let span;
  if (m >= 60) {
    const h = m / 60;
    span = `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
  } else {
    span = `${m} 分钟`;
  }
  return prefix ? `还有 ${span}` : `${span}后`;
}

/** 只到时分，用于同一天的多门课合并展示 */
function formatClock(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 单门课的提醒文本 */
function buildSingle(course, kind, when, diffMin) {
  const head = `【${KIND_LABEL[kind]}】${course.name}`;
  const tail =
    diffMin > 0
      ? `${formatDateTime(when)} ${VERB[kind]}，${remainText(diffMin)}`
      : `${formatDateTime(when)} 已${VERB[kind]}`;
  return `${head}\n${tail}`;
}

/**
 * 同一时段命中多门课时合并成一条，避免班级课表在整点集体刷屏。
 * 比如周三 08:00 同时有三门课，群里只会收到一条消息。
 */
function buildMerged(kind, rows, now) {
  const head = `【${KIND_LABEL[kind]}】${rows.length} 门课`;
  const allSameDay = rows.every((r) => sameDay(r.when, now));
  const lines = rows.map((r) => {
    const timeText = allSameDay ? formatClock(r.when) : formatDateTime(r.when);
    const remain = r.diffMin > 0 ? `（${remainText(r.diffMin, { prefix: false })}）` : '';
    return `· ${r.course.name}  ${timeText}${remain}`;
  });
  return [head, ...lines].join('\n');
}

function targetsFor(course) {
  if (course.target) return [course.target];
  // 自动发现的群也参与，这样不填 QQ_GROUP_OPENIDS 也能收到课程提醒
  return resolveTargets();
}

/**
 * 扫描课程表，找出进入提醒窗口的课程并推送。
 * 每分钟调用一次；同一群同一类提醒会合并成一条消息。
 * dryRun 为 true 时只回放会发出的内容，不实际发送、也不写提醒状态。
 */
export async function scanCourses(now = new Date(), { sender, dryRun = false, ignoreQuiet = false } = {}) {
  const courses = listCourses({ enabledOnly: true });
  if (!courses.length) return [];

  if (!ignoreQuiet && inQuietHours(now)) return [];

  // 演练模式且没有指定 sender 时走空发送，避免误发到真实群
  const send = sender || (dryRun ? async () => {} : sendGroupMessage);
  const hits = [];

  for (const course of courses) {
    const checks = [
      ['open', course.open, course.advanceOpenMin ?? 0],
      ['close', course.close, course.advanceCloseMin ?? 0],
    ];

    for (const [kind, spec, advance] of checks) {
      if (!spec) continue;
      const next = computeNext(spec, now);
      if (!next) continue;

      const key = next.toISOString();
      if (course.last?.[kind] === key) continue;

      const diffMin = (next.getTime() - now.getTime()) / 60_000;
      // 还没到应发时刻，或者事件已经开始，都不用发
      if (diffMin > advance || diffMin <= 0) continue;

      // 演练时即便还没配群也要能看到文案，用一个占位群名
      let groups = targetsFor(course);
      if (!groups.length && dryRun) groups = ['（未配置 QQ_GROUP_OPENIDS）'];

      hits.push({ course, kind, when: next, diffMin, key, groups });
    }
  }

  if (!hits.length) return [];

  // 按 群 + 提醒类型 归组，一组只发一条消息
  const buckets = new Map();
  let missingTarget = 0;
  for (const hit of hits) {
    if (!hit.groups.length) {
      missingTarget += 1;
      continue;
    }
    for (const g of hit.groups) {
      const k = `${hit.kind}::${g}`;
      if (!buckets.has(k)) buckets.set(k, { kind: hit.kind, group: g, rows: [] });
      buckets.get(k).rows.push(hit);
    }
  }

  if (missingTarget) {
    log.warn(`有 ${missingTarget} 条课程提醒因未配置 QQ_GROUP_OPENIDS 而没有发送`);
  }

  const notified = [];
  for (const { kind, group, rows } of buckets.values()) {
    const text =
      rows.length === 1
        ? buildSingle(rows[0].course, kind, rows[0].when, rows[0].diffMin)
        : buildMerged(kind, rows, now);
    try {
      await send(group, text);
      const names = rows.map((r) => r.course.name).join('、');
      log.info(
        dryRun
          ? `[演练] 将发送（${rows.length} 门 ${kind}）-> ${group}：${names}`
          : `课程提醒已发送（${rows.length} 门 ${kind}）-> ${group}：${names}`
      );
      for (const r of rows) notified.push({ id: r.course.id, kind, iso: r.key });
    } catch (err) {
      log.error(`课程提醒发送失败 ${group}: ${err.message}`);
    }
  }

  if (dryRun) {
    return hits.map((h) => ({ name: h.course.name, kind: h.kind, at: h.key }));
  }

  recordNotifiedMany(notified);

  return notified.map((n) => {
    const hit = hits.find((h) => h.course.id === n.id && h.kind === n.kind);
    return { name: hit?.course.name || '', kind: n.kind, at: n.iso };
  });
}

/**
 * 检查某门课接下来的提醒会不会落进静默时段。
 * 静默期内不发，等于这条提醒会被跳过，所以录入后应当提示用户调大提前量。
 */
export function quietRisk(course, count = 3) {
  const rows = previewCourse(course, count);
  const risky = [];
  for (const r of rows) {
    const kind = r.kind === '开课' ? 'open' : 'close';
    const advance =
      kind === 'open' ? course.advanceOpenMin ?? 0 : course.advanceCloseMin ?? 0;
    const sendAt = new Date(r.ts - advance * 60_000);
    if (inQuietHours(sendAt)) {
      risky.push({ kind: r.kind, eventAt: r.at, sendAt });
    }
  }
  return risky;
}

/** 预览某门课程接下来会发生什么，用于录入后核对 */
export function previewCourse(course, count = 2) {
  const now = new Date();
  const rows = [];

  const collect = (spec, kind) => {
    if (!spec) return;
    let base = now;
    const seen = new Set();
    for (let i = 0; i < count; i += 1) {
      const next = computeNext(spec, new Date(base.getTime() + 60_000));
      if (!next) break;
      if (next.getTime() <= base.getTime()) break;
      const key = next.toISOString();
      if (seen.has(key)) break;
      seen.add(key);
      rows.push({ kind, at: formatDateTime(next), ts: next.getTime() });
      base = next;
    }
  };

  collect(course.open, '开课');
  collect(course.close, '截止');

  return rows.sort((a, b) => a.ts - b.ts).slice(0, count * 2);
}
