const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * 是否是一个可用的时间基准。
 * 拿不到消息时间的时候宁可返回 null，也不要用「现在」顶上——
 * 用「现在」去算「明天交作业」，服务停机三天再重放事件就会算到三天后，
 * 凭空造出一个错误的截止日，比不填日期坏得多。
 */
export function validBaseDate(b) {
  return b instanceof Date && !Number.isNaN(b.getTime());
}

/**
 * 把消息时间戳转成 Date，作为「今天/明天/下周三」这类相对时间的计算基准。
 *
 * 这一条是必须的：班长在 11 月 1 日发「今天下午集合」，如果按「收到消息的那一刻」
 * 去算，隔几天补录或者服务停机后重放事件，就会解析成一个完全错误的日期。
 * 基准必须来自消息本身，而不是「现在」。
 *
 * 消息没带时间戳（或时间戳是坏的）时返回 null，调用方要按「日期待定」处理，
 * 不要自己拿 now 兜底。
 */
export function parseBaseDate(ts) {
  if (ts === null || ts === undefined || ts === '') return null;

  if (ts instanceof Date) {
    return Number.isNaN(ts.getTime()) ? null : ts;
  }

  if (typeof ts === 'number' || /^\d{9,}$/.test(String(ts).trim())) {
    const n = Number(ts);
    // 秒级时间戳（QQ 部分事件返回这个）和毫秒级差三个数量级
    const d = new Date(n < 1e11 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(String(ts));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function today() {
  return toISODate(new Date());
}

export function addDays(isoDate, days) {
  const d = parseISODate(isoDate);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** 返回 b - a 的天数差（整数） */
export function diffDays(aIso, bIso) {
  const a = parseISODate(aIso).getTime();
  const b = parseISODate(bIso).getTime();
  return Math.round((b - a) / DAY_MS);
}

export const CN_WEEKDAY = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7,
};

function startOfWeek(base, offsetWeeks) {
  const d = new Date(base);
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (dow - 1) + offsetWeeks * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 解析「时间段」：11月9日～11月27日 / 9号到27号 / 2026-11-09至2026-11-27
 * 返回 { start, end }，不是区间返回 null。
 *
 * 为什么必须分开：像「11 月 9 日～11 月 27 日内完成答题」，
 * 只记截止日 27 号的话，开始那周没有任何提示，等看到时已经过了一周。
 * 两头都要提醒。
 */
export function parseDateRange(text, base = new Date()) {
  if (!text) return null;
  const t = String(text);
  // base 未知时只用「现在」取年月补年份，「9号到27号」这类靠月份推断的照旧。
  // 区间表达式里没有「今天/明天」这种相对词，所以不涉及乱猜的问题。
  const ref = validBaseDate(base) ? base : new Date();
  const year = ref.getFullYear();

  const fix = (d) => {
    const copy = new Date(d);
    if (copy.getTime() < ref.getTime() - 180 * DAY_MS) copy.setFullYear(copy.getFullYear() + 1);
    return copy;
  };

  // 完整年份区间：2026-11-09 ~ 2026-11-27
  let m = t.match(
    /(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})\s*[日号]?\s*[~～\-—－至到]\s*(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/
  );
  if (m) {
    return {
      start: toISODate(new Date(+m[1], +m[2] - 1, +m[3])),
      end: toISODate(new Date(+m[4], +m[5] - 1, +m[6])),
    };
  }

  // 带月份：11月9日～11月27日 / 11月9日～27日
  m = t.match(
    /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*[~～\-—－至到]\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号]/
  );
  if (m) {
    const m1 = +m[1];
    const d1 = +m[2];
    const m2 = m[3] ? +m[3] : m1;
    const d2 = +m[4];
    if (m1 >= 1 && m1 <= 12 && d1 >= 1 && d1 <= 31 && m2 >= 1 && m2 <= 12 && d2 >= 1 && d2 <= 31) {
      return {
        start: toISODate(fix(new Date(year, m1 - 1, d1))),
        end: toISODate(fix(new Date(year, m2 - 1, d2))),
      };
    }
  }

  // 只有日号：9号到27号（默认同一个月，跨月靠「end 早于 start」推断）
  m = t.match(/(\d{1,2})\s*[日号]\s*[~～\-—－至到]\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const d1 = +m[1];
    const d2 = +m[2];
    if (d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31) {
      const start = fix(new Date(year, ref.getMonth(), d1));
      const end = fix(new Date(year, ref.getMonth(), d2));
      if (end.getTime() < start.getTime()) end.setMonth(end.getMonth() + 1);
      return { start: toISODate(start), end: toISODate(end) };
    }
  }

  return null;
}

/**
 * 从一段中文文本里解析「截止日期」。只处理明确、常见的表达，解析不出来返回 null。
 * 区间取结束日，开始日由 parseDateRange 单独取。
 */
export function parseDueDate(text, base = new Date()) {
  if (!text) return null;
  const t = String(text);
  // b = 真正可用的消息时间；拿不到就是 null，后面的相对日期一律不猜。
  // ref 只用来取「哪一年/哪一月」，绝对日期（11月9日）靠它补年份，跟相对日期无关。
  const b = validBaseDate(base) ? base : null;
  const ref = b || new Date();

  const range = parseDateRange(t, b);
  if (range) return range.end;

  let m = t.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) return toISODate(new Date(+m[1], +m[2] - 1, +m[3]));

  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const d = new Date(ref.getFullYear(), +m[1] - 1, +m[2]);
    if (d.getTime() < ref.getTime() - 180 * DAY_MS) d.setFullYear(d.getFullYear() + 1);
    return toISODate(d);
  }

  // 5-8、11/5 这类简写，注意排除 14:30 这种时刻
  m = t.match(/(?:^|[^\d:])(\d{1,2})[-/](\d{1,2})(?:[^\d:]|$)/);
  if (m && +m[1] <= 12 && +m[2] <= 31) {
    const d = new Date(ref.getFullYear(), +m[1] - 1, +m[2]);
    if (d.getTime() < ref.getTime() - 180 * DAY_MS) d.setFullYear(d.getFullYear() + 1);
    return toISODate(d);
  }

  // 11.9号 这种用点分隔的。必须带「号/日」，否则「作业2.5」会被当成 2 月 5 日
  m = t.match(/(?:^|[^\d:])(\d{1,2})\.(\d{1,2})\s*[日号]/);
  if (m && +m[1] <= 12 && +m[2] <= 31) {
    const d = new Date(ref.getFullYear(), +m[1] - 1, +m[2]);
    if (d.getTime() < ref.getTime() - 180 * DAY_MS) d.setFullYear(d.getFullYear() + 1);
    return toISODate(d);
  }

  // 「15号」「21日」这种只给日号、不写月份的。当月已过就顺延到下月
  m = t.match(/(?:^|[^\d])(\d{1,2})\s*[日号]/);
  if (m && +m[1] >= 1 && +m[1] <= 31) {
    const d = new Date(ref.getFullYear(), ref.getMonth(), +m[1]);
    const todayMid = new Date(ref);
    todayMid.setHours(0, 0, 0, 0);
    if (d.getTime() < todayMid.getTime()) d.setMonth(d.getMonth() + 1);
    return toISODate(d);
  }

  // —— 从这里往下全是相对表述，没有消息时间就一律不解析 ——
  // 「明天交」在不知道消息是哪天发的时候，答案可以是任何一天。
  // 猜一个日期写进待办库，比留空（进「日期待定」）危险得多。
  if (!b) return null;

  if (/大后天/.test(t)) return addDays(toISODate(b), 3);
  if (/后天/.test(t)) return addDays(toISODate(b), 2);
  if (/(明天|明日|明早|明晚|明儿)/.test(t)) return addDays(toISODate(b), 1);
  if (/(今天|今日|今晚|今早|今儿)/.test(t)) return toISODate(b);

  m = t.match(/(\d{1,2})\s*天\s*(?:后|内|以后)/);
  if (m) return addDays(toISODate(b), +m[1]);

  m = t.match(/(下下|下|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
  if (m) {
    const weekOffset = m[1] === '下' ? 1 : m[1] === '下下' ? 2 : 0;
    const targetDow = CN_WEEKDAY[m[2]];
    const weekStart = startOfWeek(b, weekOffset);
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + (targetDow - 1));
    if (!m[1] || m[1] === '这' || m[1] === '本') {
      const todayMidnight = new Date(b);
      todayMidnight.setHours(0, 0, 0, 0);
      if (d.getTime() < todayMidnight.getTime()) d.setDate(d.getDate() + 7);
    }
    return toISODate(d);
  }

  return null;
}

const CN_NUM = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 把「三」「十」「十二」「二十三」这类中文数字转成阿拉伯数字 */
export function cnToNum(s) {
  const str = String(s ?? '').trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return Number(str);
  if (str.length === 1) return CN_NUM[str] ?? null;
  if (str[0] === '十') {
    const rest = str.slice(1);
    return 10 + (CN_NUM[rest] ?? 0);
  }
  if (str[1] === '十') {
    const head = CN_NUM[str[0]];
    const tail = str[2] ? CN_NUM[str[2]] : 0;
    if (head === undefined || tail === undefined) return null;
    return head * 10 + tail;
  }
  return null;
}

/**
 * 从文本里解析「具体时刻」，返回 HH:mm 或 null。
 * 支持：14:30、14：30、下午3点、下午三点半、晚上八点、上午九点十五、18点
 */
export function parseTime(text) {
  if (!text) return null;
  const t = String(text);

  // 精确时刻，但排除 "11/5" 这种
  let m = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})(?!\d)/);
  if (m) {
    const h = +m[1];
    const mi = +m[2];
    if (h <= 23 && mi <= 59) return `${pad(h)}:${pad(mi)}`;
  }

  m = t.match(
    /(凌晨|早上|上午|中午|下午|傍晚|晚上|今晚|明晚|夜里)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[点時时]\s*(半|(\d{1,2}|[一二三四五六七八九十]{1,3})\s*分?)?/
  );
  if (m) {
    let h = cnToNum(m[2]);
    if (h === null) return null;
    const mi = m[3] === '半' ? 30 : m[4] ? (cnToNum(m[4]) ?? 0) : 0;
    const prefix = m[1] || '';
    if (/下午|傍晚|晚上|今晚|明晚|夜里|中午/.test(prefix) && h < 12) h += 12;
    if (h <= 23 && mi <= 59) return `${pad(h)}:${pad(mi)}`;
  }

  return null;
}

/** 同时解析日期和时刻 */
export function parseDueDateTime(text, base = new Date()) {
  return { date: parseDueDate(text, base), time: parseTime(text) };
}

/**
 * 渲染截止时间。
 * group 传 'today' / 'tomorrow' 时只显示时刻，因为分组标题已说明是哪天。
 */
export function formatDue(due, time, { group, start } = {}) {
  if (!due) return '';
  const md = (iso) => {
    const [, m, d] = String(iso).split('-');
    return `${Number(m)}月${Number(d)}日`;
  };

  // 区间任务显示成「11月9日～11月27日」，两头都看得见。
  // 这种情况不能走 group 的「只显示时刻」优化，否则区间就没了。
  if (start && start !== due) {
    const rangePart = `${md(start)}～${md(due)}`;
    return time ? `${rangePart} ${time}` : rangePart;
  }

  if (group === 'today' || group === 'tomorrow') return time || '';
  const datePart = md(due);
  if (!time) return datePart;
  return `${datePart} ${time}`;
}

/** 兼容旧调用 */
export function humanDate(isoDate) {
  const delta = diffDays(today(), isoDate);
  const [, mm, dd] = isoDate.split('-');
  const base = `${Number(mm)}月${Number(dd)}日`;
  if (delta === 0) return `${base}（今天）`;
  if (delta === 1) return `${base}（明天）`;
  if (delta === 2) return `${base}（后天）`;
  if (delta < 0) return `${base}（逾期${-delta}天）`;
  return base;
}

/** 给定周几（1=周一 ... 7=周日）和时刻，算出下一次发生的时间点 */
export function nextWeekdayTime(weekday, time = '00:00', base = new Date()) {
  const [h, mi] = String(time).split(':').map(Number);
  const d = new Date(base);
  const curDow = d.getDay() === 0 ? 7 : d.getDay();
  const offset = (weekday - curDow + 7) % 7;
  const candidate = new Date(d);
  candidate.setDate(d.getDate() + offset);
  candidate.setHours(h, mi, 0, 0);
  if (candidate.getTime() <= base.getTime()) candidate.setDate(candidate.getDate() + 7);
  return candidate;
}

/** 给定日期所在周的周一与周日（ISO 字符串） */
export function weekRange(isoDate = today()) {
  const d = parseISODate(isoDate);
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  const start = new Date(d);
  start.setDate(d.getDate() - (dow - 1));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: toISODate(start), end: toISODate(end) };
}

/** 用日期 + 时刻组合出具体时间点 */
export function atDateTime(isoDate, time = '00:00') {
  const [h, mi] = String(time).split(':').map(Number);
  const d = parseISODate(isoDate);
  d.setHours(h, mi, 0, 0);
  return d;
}

export function formatDateTime(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export function nowHM() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export { pad };
