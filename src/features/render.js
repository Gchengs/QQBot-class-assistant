import { today, diffDays, formatDue, formatDateTime } from '../utils/date.js';

const HARD_LIMIT = 200;
const FLAT_THRESHOLD = 4;

const EMPTY_TEXT = '这个群暂时没有待办。\n\n记一条：#待办 @某人 明天14:00 交材料';

function cleanTitle(t) {
  return String(t.title || '').replace(/\s+/g, ' ').trim();
}

/**
 * 负责人标记。
 * 班级群里「学委、纪检委员、副班长、寝室长、助辅」这类职务指派才是真实写法，
 * 只写标题不写人，等于把责任摊平到全班，最后谁都不动。
 *
 * owner 为空不是「忘了写」，而是这件事本来就是全班一起做的——
 * 但空着看起来像漏了，所以显式写成〔全体〕，一眼能分清
 * 「这是大家的事」和「这是漏标了」。
 */
function ownerTag(t) {
  const o = String(t.owner || '').trim();
  return `〔${o || '全体'}〕`;
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 标题里已经写了日期就不再显示一遍。
 * 录入时常把日期直接写进标题（「CAD 上课 11.7」），渲染时再跟一个「11月7日」就是重复。
 * 正则带数字边界，避免 11.1 误命中 11.14。
 */
function titleHasDate(title, due) {
  if (!due) return false;
  const [, mm, dd] = String(due).split('-');
  const m = Number(mm);
  const d = Number(dd);
  if (!m || !d) return false;
  const pad = (n) => String(n).padStart(2, '0');
  const forms = [
    `${m}月${d}日`,
    `${m}月${d}号`,
    `${m}.${d}`,
    `${m}/${d}`,
    `${m}-${d}`,
    `${pad(m)}.${pad(d)}`,
    `${pad(m)}/${pad(d)}`,
    `${pad(m)}-${pad(d)}`,
  ];
  const text = String(title || '');
  return forms.some((f) => new RegExp(`(^|[^0-9])${escRe(f)}(?![0-9])`).test(text));
}

/** 平铺模式：条目少的时候一行一条，不带分组 */
function mdOf(iso) {
  const [, m, d] = String(iso).split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function flatDue(t) {
  if (!t.due) return '';

  // 区间任务优先，避免被「今天/明天」或标题自带日期吞掉开始日
  if (t.due_start && t.due_start !== t.due) {
    const range = `${mdOf(t.due_start)}～${mdOf(t.due)}`;
    return t.due_time ? `${range} ${t.due_time}` : range;
  }

  const delta = diffDays(today(), t.due);
  if (delta === 0) return t.due_time ? `今天 ${t.due_time}` : '今天';
  if (delta === 1) return t.due_time ? `明天 ${t.due_time}` : '明天';
  // 标题自带日期时只留时间
  if (titleHasDate(t.title, t.due)) return t.due_time || '';
  const datePart = mdOf(t.due);
  return t.due_time ? `${datePart} ${t.due_time}` : datePart;
}

function renderFlat(todos, title) {
  const lines = todos.slice(0, HARD_LIMIT).map((t, i) => {
    const due = flatDue(t);
    const tag = ownerTag(t);
    const head = `${i + 1}. ${cleanTitle(t)}${tag}`;
    return due ? `${head}  ${due}` : head;
  });
  const extra =
    todos.length > HARD_LIMIT ? `\n…还有 ${todos.length - HARD_LIMIT} 项` : '';
  return `${title}\n\n${lines.join('\n')}${extra}`;
}

function isoOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本周日与下周日的日期，用来把「本周 / 下周」按自然周切分 */
function weekBoundary() {
  const now = new Date();
  const dow = now.getDay() === 0 ? 7 : now.getDay();
  const thisSun = new Date(now);
  thisSun.setDate(now.getDate() + (7 - dow));
  const nextSun = new Date(thisSun);
  nextSun.setDate(thisSun.getDate() + 7);
  return { thisSun: isoOf(thisSun), nextSun: isoOf(nextSun) };
}

/** 分组模式：条目多的时候按紧急度分段，空段不显示 */
function renderGrouped(todos, title) {
  const t = today();
  const { thisSun, nextSun } = weekBoundary();
  // 「今天 / 明天」优先判定，避免周日时「明天」与「下周」重叠
  const groups = [
    ['today', '今天', todos.filter((x) => x.due === t)],
    ['tomorrow', '明天', todos.filter((x) => x.due && diffDays(t, x.due) === 1)],
    [
      'week',
      '本周',
      todos.filter((x) => x.due && x.due > t && diffDays(t, x.due) !== 1 && x.due <= thisSun),
    ],
    ['nextweek', '下周', todos.filter((x) => x.due && x.due > thisSun && x.due <= nextSun)],
    ['later', '后续', todos.filter((x) => x.due && x.due > nextSun)],
    ['none', '未定日期', todos.filter((x) => !x.due)],
  ];

  const blocks = [];
  let idx = 1;
  let shown = 0;

  for (const [key, label, items] of groups) {
    if (!items.length) continue;
    const lines = [];
    for (const item of items) {
      if (shown >= HARD_LIMIT) break;
      let due =
        key === 'none'
          ? ''
          : formatDue(item.due, item.due_time, { group: key, start: item.due_start });
      // 标题里已经写了日期，就只保留时间，别再跟一遍「11月7日」
      if (due && !item.due_start && titleHasDate(item.title, item.due)) due = item.due_time || '';
      const head = `${idx}. ${cleanTitle(item)}${ownerTag(item)}`;
      lines.push(due ? `${head}  ${due}` : head);
      idx += 1;
      shown += 1;
    }
    if (lines.length) blocks.push(`${label}\n${lines.join('\n')}`);
    if (shown >= HARD_LIMIT) break;
  }

  const extra = todos.length > shown ? `\n…还有 ${todos.length - shown} 项` : '';
  return `${title}\n\n${blocks.join('\n\n')}${extra}`;
}

function render(todos, title) {
  const list = todos.filter((t) => t && t.title);
  if (!list.length) return null;
  if (list.length <= FLAT_THRESHOLD) return renderFlat(list, title);
  return renderGrouped(list, title);
}

/** 过滤掉已逾期、已完成、已作废、已自动归档的，逾期项按需求完全不展示 */
export function activeOnly(todos) {
  const t = today();
  return (todos || []).filter(
    (x) =>
      x &&
      x.title &&
      x.status !== 'done' &&
      x.status !== 'dropped' &&
      x.status !== 'expired' &&
      (!x.due || x.due >= t)
  );
}

/** 上一次推给这个群的清单，用来支持「#完成 3」按编号销项（进程重启会丢，够用） */
const shownCache = new Map();

export function pickByIndex(group, n) {
  const list = shownCache.get(group);
  if (!list || !Number.isInteger(n) || n < 1 || n > list.length) return null;
  return list[n - 1];
}

/** 被 @ 时的回复 */
export function renderSummary(todos, group) {
  const list = activeOnly(todos);
  if (!list.length) return EMPTY_TEXT;
  if (group) shownCache.set(group, list);
  const body = render(list, `【待办】共 ${list.length} 项`);
  return `${body}\n\n销项：#完成 关键词（或 #完成 编号）`;
}

/** 每天 18:00 的推送。操作提示只放在被 @ 的回复里，定时推送不带，免得每期都重复 */
export function renderDigest(todos, group) {
  const list = activeOnly(todos);
  if (!list.length) return null;
  if (group) shownCache.set(group, list);
  return render(list, `【待办日报】共 ${list.length} 项`);
}

/**
 * 周报。
 *
 * 分成四段：逾期未完成 / 本周到期 / 日期待定 / 无期限。
 * 后两段是「没有截止日」的项，会跟着每期周报重复出现，所以由 pushWeekly 按次数衰减
 * （日期待定 3 次、无期限 2 次），这里只负责渲染。
 *
 * 返回 { text, shownIds } —— shownIds 用来记「这一条真的推出去过一次」。
 * 只看传入了哪些项是不够的，超过行数被截断的那些并没有真的出现在群里。
 */
export function renderWeekly(
  {
    overdue = [],
    inProgress = [],
    thisWeek = [],
    nextWeek = [],
    later = [],
    pending = [],
    ongoing = [],
  } = {}
) {
  const total =
    overdue.length +
    inProgress.length +
    thisWeek.length +
    nextWeek.length +
    later.length +
    pending.length +
    ongoing.length;
  if (!total) {
    return { text: '【本周待办】0 项\n\n这周没有安排。', shownIds: [] };
  }

  // 单条上限 1200 字。加了「后续」块之后行数会变多，
  // 24 行 × 约 35 字 ≈ 840 字，离上限还有余量；再多的才截断成「还有 N 项」。
  const MAX_LINES = 24;
  const blocks = [];
  const shownIds = [];
  let idx = 1;

  const push = (label, items) => {
    const lines = [];
    for (const item of items) {
      if (shownIds.length >= MAX_LINES) break;
      let due = item.due ? formatDue(item.due, item.due_time, { start: item.due_start }) : '';
      if (due && !item.due_start && titleHasDate(item.title, item.due)) due = item.due_time || '';
      const head = `${idx}. ${cleanTitle(item)}${ownerTag(item)}`;
      lines.push(due ? `${head}  ${due}` : head);
      idx += 1;
      if (item.id) shownIds.push(item.id);
    }
    if (lines.length) blocks.push(`${label}\n${lines.join('\n')}`);
  };

  push('逾期未完成', overdue);
  push('进行中', inProgress);
  push('本周剩余', thisWeek);
  push('下周', nextWeek);
  push('后续', later);
  push('日期待定', pending);
  push('无期限', ongoing);

  const extra =
    total > shownIds.length ? `\n…还有 ${total - shownIds.length} 项，@我 看全部。` : '';
  return {
    text: `【本周待办】共 ${total} 项\n\n${blocks.join('\n\n')}${extra}`,
    shownIds,
  };
}

/** 到期前一天的提醒 */
export function renderReminder(items) {
  if (!items.length) return null;
  const lines = items.map((t, i) => {
    const due = t.due_time ? `  ${t.due_time}` : '';
    return `${i + 1}. ${cleanTitle(t)}${ownerTag(t)}${due}`;
  });
  return `【明天截止】${items.length} 项\n\n${lines.join('\n')}\n\n完成后发 #完成 关键词`;
}

/**
 * 分组的到期提醒：今天截止 / 明天截止 合成一条，编号连续。
 * 只写「明天截止」会漏掉当天才想起来的情况，所以两组一起发。
 */
export function renderReminderGroups(groups) {
  const valid = (groups || []).filter((g) => g && g.items && g.items.length);
  const total = valid.reduce((s, g) => s + g.items.length, 0);
  if (!total) return null;

  let idx = 1;
  const blocks = valid.map(({ label, items }) => {
    const lines = items.map((t) => {
      const due = t.due_time ? `  ${t.due_time}` : '';
      return `${idx++}. ${cleanTitle(t)}${ownerTag(t)}${due}`;
    });
    return `${label}\n${lines.join('\n')}`;
  });

  return `【到期提醒】${total} 项\n\n${blocks.join('\n\n')}\n\n完成后发 #完成 关键词`;
}

/** 课程提醒文案 */
export function renderCourseNotice({ name, kind, when, remainText, extra }) {
  const head = kind === 'open' ? '【开课提醒】' : '【截止提醒】';
  const lines = [
    `${head}${name}`,
    remainText ? `${remainText}` : '',
    `${formatDateTime(when)}${extra ? ` · ${extra}` : ''}`,
  ].filter(Boolean);
  return lines.join('\n');
}
