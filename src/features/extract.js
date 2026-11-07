import { parseDueDate, parseDateRange, parseTime, toISODate } from '../utils/date.js';
import { chat, llmEnabled, extractJson } from '../llm.js';
import { log } from '../logger.js';
import { inferOwnerByTopic } from './owner-rules.js';

const EXPLICIT = /^[#＃]待办\s*/;

/** 判断这条消息是否值得送去模型判断（省 token、降延迟） */
export function looksLikeTodo(text) {
  const t = String(text || '');
  if (t.length < 4 || t.length > 400) return false;
  if (/^\s*[#＃]待办/.test(t)) return false; // 显式指令走另一条路
  const signals = [
    /(今天|明天|后天|大后天|本周|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天]|\d+\s*月\s*\d+\s*[日号]|\d{1,2}[-/]\d{1,2})/,
    /(之前|截止|deadline|前给|前交|前发|前完成)/i,
    /(记得|麻烦|帮忙|请|需要|安排|确认|提交|准备|跟进|整理|对接|回一下|发我|给我|搞定|落实|催一下)/,
    /(负责|owner|交付)/,
  ];
  return signals.some((re) => re.test(t));
}

/**
 * 没有截止日的待办，分两种，衰减速度不同。
 *
 *   pending（日期待定）—— 事情一定会发生，只是日期还没通知。
 *     如「最近可能会有机械制图实验课，大家注意一下」
 *   ongoing（无期限）—— 本身就持续有效，永远不会有一个截止日。
 *     如「看 CAD 回放」「带学生手册」「新生杯陆续开始报名」
 *
 * 周报每期都带上它们，看着像在催，其实无从下手。所以给它们一个次数上限：
 * pending 出现 3 次、ongoing 出现 2 次之后就不再出现在推送里（库里仍保留）。
 */
const ONGOING_WORDS =
  /(无期限|无截止|不限时|长期|随时|有空|自行安排|自己安排|尽量|方便时|任意时间|持续|陆续|长期有效|看回放|回放|自学|自己看|按需)/;

/**
 * 更强的一批「长期有效」信号。
 * ONGOING_WORDS 里「尽量」「持续」这类词太软，配上动作词会把闲聊收进来；
 * 这里的词本身就意味着「没有截止日」，配上动作词就可以直接收成 ongoing。
 */
const ONGOING_STRONG =
  /(无期限|无截止|长期有效|不限时|看回放|回放|自学|自己看|随时|有空)/;

const PENDING_WORDS =
  /(近期|最近|即将|稍后|待定|待通知|另行通知|等通知|后续|可能会有|可能安排|注意一下|留意|择期|届时|不日|下周内|时间另)/;

/** 判断一条没有日期的待办属于哪一种 */
export function classifyUndated(text) {
  const t = String(text || '');
  if (/(待定|待通知|另行通知|等通知|时间另|择期|届时)/.test(t)) return 'pending';
  // 强信号（长期有效、看回放）优先于「注意一下」这类弱待定词
  if (ONGOING_STRONG.test(t)) return 'ongoing';
  if (PENDING_WORDS.test(t)) return 'pending';
  if (ONGOING_WORDS.test(t)) return 'ongoing';
  // 默认按待定处理：宁可多留一期，也不要把「等通知的事」提前丢掉
  return 'pending';
}

/** ongoing / pending 的标记词不该留在标题里 */
const TIME_STATE_PREFIX = /^(无期限|无截止|不限时|长期有效|长期|待定|待通知|另行通知)\s*[的：:，,]?\s*/;

/**
 * 解析显式指令：#待办 @张三 周五 交报价单
 * @ 的人名来自 events 的 mentions 字段，正文里已被替换成占位符，这里用 owner 覆盖。
 * base 是消息发送时间，用来解析「明天」「下周三」这类相对日期。
 */
export function parseExplicit(content, mentions, base = new Date()) {
  const body = String(content || '').replace(EXPLICIT, '').trim();
  if (!body) return null;

  const owner = mentions?.[0]?.username || '';
  const range = parseDateRange(body, base);
  const due = parseDueDate(body, base);
  const dueTime = parseTime(body);
  const title = body
    .replace(/@\S+/g, ' ')
    .replace(TIME_STATE_PREFIX, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) return null;
  return {
    title,
    owner,
    ownerOpenid: mentions?.[0]?.member_openid || '',
    due,
    dueStart: range?.start || null,
    dueTime,
    timeState: due ? 'dated' : classifyUndated(body),
  };
}

/**
 * 纯规则抽取，不依赖大模型。
 *
 * 群聊里的自然语言太杂，规则版只在「信息足够明确」时才认：
 *   a) 动作词 + 能解析出的日期
 *   b) 动作词 + 明确 @ 了某人
 *   c) 截止类字样 + 能解析出的日期（即使没有动作词，也是明确的任务通知）
 * 其余一律丢弃。宁可漏掉十条，也不要把闲聊塞进待办库——
 * 待办库里混进噪音，周报每期都会带着，比漏掉更烦人。
 */
const ACTION_WORDS =
  /(交(?!流|通|往|易|换|涉|代|付)|提交|上交|报名|填写|填表|填报|填一下|填(?!写|报|充)|发我|发给我|发给|发送|发(?=[\s。，,！!?？]|$)|送给|交给|交到|送到|带给|上传|下载|截图|拍照|投票|答题|作答|完成(?!了|的)|准备|整理|汇总|统计|收齐|核对|申报|注册|查询|组织|举行|占座|参会|参加|签到|打卡|复习|预习|打印|带到|带上|带好|记得带|领取|开会|集合|通知|安排|跟进|对接|检查|自查|抽查|排查|看(?!起来|上去|到|了|见|着)|带队|集合|前往|到场|听课|上课|收看|观看|听讲|举办|开展|开设)/;

/** 有明确时间点的事件。没有动作词，但配上日期就是该被提醒的事 */
const EVENT_WORDS =
  /(考试|测验|小测|期中|期末|补考|讲座|报告会|班会|例会|答辩|体测|体检|面试|宣讲会|答疑|培训|实验课|上机|实验|实习|选课|报名)/;

/** 截止类字样：命中且能解析出日期，就算没有动作词也认 */
const DEADLINE_WORDS =
  /(截止|ddl|deadline|之前|以前|前交|前发|前给|前完成|前提交|务必|尽快|记得|别忘)/i;

/** 祈使语气。命中的话，即使没写日期也认——班级群大量通知是这个句式 */
const IMPERATIVE_WORDS = /(请|记得|务必|别忘|麻烦)/;

/** 已经完成的事，不抽 */
const DONE_PATTERN = /(已经?结束|已完成|已经完成|圆满结束|已经?截止|已过期)/;

/** 纯应答、纯情绪、纯起哄，不可能是待办 */
const NOISE =
  /^(收到|好的|好滴|好嘞|好|嗯嗯|嗯|哦|ok|OK|行|可以|没问题|哈哈+|笑死|草|牛|6|666|\+1|收到收到|明白了|懂了|谢谢|感谢|辛苦了?|在吗|有人吗|代办|打卡)[\s!！。.~～？?]*$/;

/**
 * 真实群消息长这样：一串 @全体成员、表情占位符、三四百字的长通知，
 * 真正要做的事埋在中间某一句话里。所以不能拿整段原文当标题。
 * 处理流程：清洗 → 分句 → 挑第一个带动作/事件的句子当标题 → 日期从整条消息里找。
 */
function normalize(raw) {
  return String(raw || '')
    .replace(/<@!?[^>]*>/g, ' ')
    .replace(/@\s*(全体成员|所有人|全体)/g, ' ')
    .replace(/@\s*all\b/gi, ' ')
    .replace(/\[[^\]]{1,12}\]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按句号/分号/换行切句；单句过长再按逗号切碎，避免整段被当成一句 */
function splitSentences(text) {
  const out = [];
  for (const seg of text.split(/[。！？；!?;\n]+/)) {
    const s = seg.replace(/^[\s，,、]+/, '').trim();
    if (!s) continue;
    if (s.length <= 60) {
      out.push(s);
      continue;
    }
    for (const part of s.split(/[，,]/)) {
      const p = part.trim();
      if (p) out.push(p);
    }
  }
  return out;
}

/** 挑第一个带动作词或事件词的句子，作为标题来源。已经完成的事跳过 */
/** 事件名词：句子里出现这些，说明这句在讲「有件事」，值得当标题 */
const EVENT_NOUN =
  /(讲座|报告|考试|活动|会议|比赛|大赛|培训|课程|班会|参观|报名|答辩|汇报|演出|晚会|运动会|体检|申报|填报)/;

/** 剥掉客套与祈使词之后还剩多少实义字，用来判断这是不是一句空话 */
function bareLen(s) {
  return s
    .replace(/[请麻烦务必记得大家各位同学们有意向的按时]/g, '')
    .replace(/(准时|按时)?参加|谢谢|配合|回复|收到/g, '')
    .replace(/[\s，,。、！!？?：:；;]/g, '').length;
}

/**
 * 给每个句子打分，挑最像「要做的事」的那句当标题。
 *
 * 以前是「第一个带动作词的句子就上」，问题很具体：
 * 「刚刚近七点接保卫处通知……实验室发生爆炸」里「通知」也是动作词，
 * 结果整条背景叙述被当成待办标题，真正的「请各班班长统计并上报」反而丢了。
 *
 * 打分逻辑：
 *   有动作词        +3
 *   有祈使词        +2
 *   有事件名词      +2
 *   有期限词        +2
 *   有日期且有动作  +1
 *   讲缘由的句子    -4   （「为扎实推进……」「据了解……」，说的是为什么，不是要做什么）
 *   剥完客套没剩字  -4   （「请有意向的同学准时参加」这种，当标题等于没写）
 */
function scoreSentence(s) {
  let score = 0;
  const hasAction = ACTION_WORDS.test(s);
  if (hasAction) score += 3;
  if (IMPERATIVE_WORDS.test(s)) score += 2;
  if (EVENT_NOUN.test(s)) score += 2;
  if (DEADLINE_WORDS.test(s)) score += 2;
  if (hasAction && DATE_LIKE.test(s)) score += 1;
  if (/^(为|为了|由于|鉴于|据了解|据悉|近日|刚刚|近期|按.{0,6}要求)/.test(s)) score -= 4;
  if (bareLen(s) < 6) score -= 4;
  return score;
}

function pickCoreSentence(sentences) {
  let best = '';
  let bestScore = 0;
  for (const s of sentences) {
    if (DONE_PATTERN.test(s)) continue;
    const score = scoreSentence(s);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  // 一句都没过线就退回第一句，至少还能靠后半段的规则兜一层
  if (!best) return sentences.find((s) => !DONE_PATTERN.test(s)) || '';
  return best;
}

/**
 * 找出跟 due 写在同一句话里的时刻。
 * 不能直接拿整条消息里第一个时间，否则会出现「11月21日期中考试」配上
 * 「15号答疑课 18:30」的时刻，拼出一个不存在的时间点。
 */
/**
 * 句子里的「日期短语」，只用来定位位置，不负责算日期。
 * 点分隔要求带「号/日」，否则「作业2.5」会被当成日期。
 */
const DATE_LIKE =
  /(\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{1,2}\s*[./-]\s*\d{1,2}\s*[日号]|\d{1,2}\s*[日号]|大后天|后天|明天|明日|今晚|明晚|今早|今天|今日|本周[一二三四五六日天]?|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天])/;

/**
 * 在整条消息里挑一个「最可能是截止日」的日期。
 *
 * 为什么不能简单取第一个日期：
 * 「11月2号上海某高校实验室爆炸……请各班班长统计并于11月8日前上报」
 * 第一个日期是事故时间，属于背景；真正的死线是 11 月 8 日。
 * 取第一个会把一条死线存成四天前的过去时间——这比不收还糟，
 * 用户看到的是「明天要上报」，系统里记的却是「已经过了」。
 *
 * 优先级：
 *   1) 紧挨期限词（前面/前/截止/之前/上报）的日期，取最早的一个
 *   2) 不早于消息发送日的日期，取最早的一个
 *   3) 全都早于发送日 → 不认，落进「日期待定」，让人自己填
 */
const DEADLINE_CUE = /^(前|之前|以前|截止|前完成|前上报|前提交|前交|前发)/;
const DEADLINE_CUE_BEFORE = /(截止|截至|定于|限|于)$/;

function pickBestDue(text, base) {
  const t = String(text || '');
  const baseMid = new Date(base);
  baseMid.setHours(0, 0, 0, 0);
  const baseIso = toISODate(baseMid);

  const cands = [];
  const g = new RegExp(DATE_LIKE.source, 'g');
  let m;
  while ((m = g.exec(t))) {
    const due = parseDueDate(m[0], base);
    if (!due) continue;
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 4);
    const before = t.slice(Math.max(0, m.index - 3), m.index);
    cands.push({
      due,
      cued: DEADLINE_CUE.test(after) || DEADLINE_CUE_BEFORE.test(before),
      future: due >= baseIso,
    });
  }
  if (!cands.length) return null;

  const byDate = (a, b) => a.due.localeCompare(b.due);
  const cued = cands.filter((c) => c.cued).sort(byDate);
  if (cued.length) return cued[0].due;

  const future = cands.filter((c) => c.future).sort(byDate);
  if (future.length) return future[0].due;

  return null;
}

function timeInSameSentence(sentences, due, base = new Date()) {
  if (!due) return null;
  for (const s of sentences) {
    const g = new RegExp(DATE_LIKE.source, 'g');
    let m;
    while ((m = g.exec(s))) {
      if (parseDueDate(m[0], base) !== due) continue;
      // 只认「紧跟在 due 后面、且中间没有再出现别的日期」的那个时刻。
      // 否则「11月21日期中考试，15号18:30答疑」会把 18:30 挂到 21 号头上。
      const after = s.slice(m.index + m[0].length);
      const nextDate = after.search(new RegExp(DATE_LIKE.source));
      const seg = nextDate >= 0 ? after.slice(0, nextDate) : after;
      const tm = parseTime(seg);
      if (tm) return tm;
    }
  }
  return null;
}

/**
 * 班级群里「谁来做」几乎从不 @ 人，而是用职务：学委、纪检委员、副班长、寝室长、助辅。
 * 抽不出负责人就默认是全体的事，但很多事其实只归某一个人——
 * 周报里只写标题不写人，等于把责任摊平，最后谁都不动。
 * 这里只认「由/请/各班 + 职务」这类明确指派结构，
 * 避免正文里随便提到「辅导员」就被误判成负责人。
 */
const ROLES = [
  '团支部书记', '助理辅导员', '小寝室长', '学习委员', '纪律委员', '纪检委员',
  '生活委员', '宣传委员', '组织委员', '体育委员', '文艺委员', '心理委员',
  '副班长', '团支书', '班委会', '辅导员', '班主任', '寝室长', '宿舍长', '小组长',
  '班长', '副班', '正班', '学委', '宣委', '体委', '文委', '助辅', '导员', '班委', '组长',
];

const ROLE_ALT = ROLES.join('|');

/** 从正文里找出被指派的职务，找不到返回空字符串（= 全体成员） */
export function findRoleOwner(text) {
  const t = String(text || '');
  if (!t) return '';

  const lead = new RegExp(
    `(?:由|请|麻烦|安排|要求)\\s*(?:各班|各位|所有|全体)?\\s*(${ROLE_ALT})`
  );
  let m = t.match(lead);
  if (m) return m[1];

  m = t.match(new RegExp(`(?:各班|各位|全部)\\s*(${ROLE_ALT})`));
  if (m) return m[1];

  m = t.match(
    new RegExp(`(${ROLE_ALT})\\s*(?:负责|组织|汇总|收齐|统计|牵头|落实|跟进|安排)`)
  );
  if (m) return m[1];

  return '';
}

/** 前缀会叠好几层：「请各位来教学楼前…」「麻烦各班纪检委员…」，一次只剥一层，得循环 */
const LEAD_PREFIX =
  /^(那个|然后|所以|还有|另外|顺便|对了|(?:今天|今日|明天|明日|后天|大后天|昨天)的|大家|各位|同学们|同学|各班|家人们|兄弟们|姐妹们|请|麻烦|记得|别忘了|别忘记|帮忙|帮我|把|的)[，,：:]?\s*/;

/**
 * 句首的时间状语：「明天高数课之前，」「11月7日晚上七点，」「本周三，」。
 * 日期已经单独解析到截止日里了，留在标题里就是重复的噪音——
 * 「明天高数课之前，大家记得把第二章的整理按照宿舍上交」应该只剩后半句。
 * 只剥到第一个逗号，且要求剩下的内容还够长，避免把整句时间当标题削没。
 */
const LEAD_TIME =
  /^(?:在\s*)?(?:今天|明天|后天|大后天|昨天|前天|今晚|明晚|昨晚|今早|明早|本周|这周|下周|上周|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*[月./]\s*\d{1,2}\s*[日号]?|[一二三四五六七八九十]{1,3}\s*月\s*[一二三四五六七八九十\d]{1,3}\s*[日号]?)[^，,。；;]{0,12}?[，,、]\s*/;

/** 同样的时间状语，但后面没有逗号、直接跟「前/之前」：「今晚22:00前把表发我」 */
const LEAD_TIME_NC =
  /^(?:在\s*)?(?:今天|明天|后天|大后天|今晚|明晚|今早|明早|本周[一二三四五六日天]?|这周|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*[月./]\s*\d{1,2}\s*[日号]?|[一二三四五六七八九十]{1,3}\s*月\s*[一二三四五六七八九十\d]{1,3}\s*[日号]?)(?:\s*\d{1,2}\s*[:：]\s*\d{1,2})?\s*(?:之前|以前|前)\s*/;

function stripTimeLead(s) {
  let cur = String(s || '');
  for (let i = 0; i < 3; i += 1) {
    // 两个正则都可能命中，取更长的那个，避免「今晚22:00前」只被削掉「今晚」
    const m = [cur.match(LEAD_TIME), cur.match(LEAD_TIME_NC)]
      .filter(Boolean)
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!m) break;
    const seg = m[0];
    const rest = cur.slice(seg.length);
    // 时间状语里常夹着真正的事件词：「本周三下午三点半班会，」。
    // 整段删会把「班会」一起吃掉，那就从事件词开始保留。
    const hits = [ACTION_WORDS, EVENT_WORDS]
      .map((re) => seg.match(re)?.index ?? -1)
      .filter((x) => x >= 0);
    let next = rest;
    if (hits.length) {
      const at = Math.min(...hits);
      // 「明天早上8点在操场集合，」的动作词是「集合」，
      // 但只留「集合」太干，把前面的介词一起带上变成「在操场集合」
      const prep = seg.lastIndexOf('在', at);
      const from = prep >= 0 && at - prep <= 6 ? prep : at;
      next = seg.slice(from) + rest;
    }
    const trimmed = next.trim();
    // 剥完只剩一两个字，说明这条消息本来就是纯时间播报，别动
    if (!trimmed || trimmed.length < 3) break;
    cur = next;
  }
  return cur;
}

/** 时间状语和「请大家/记得/把」经常交替出现，得一起循环剥 */
function stripLeadAndTime(s) {
  let cur = String(s || '');
  for (let i = 0; i < 5; i += 1) {
    const next = stripLead(stripTimeLead(cur));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function stripLead(s) {
  let cur = String(s || '');
  for (let i = 0; i < 5; i += 1) {
    const next = cur.replace(LEAD_PREFIX, '').replace(/^[\s，,、：:]+/, '');
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function cleanRuleTitle(t) {
  // 课表/活动通知常见的键值格式：「主题：AutoCAD中级2班 时间：11月7日 13:30 地点：教4-305」
  // 整段当标题会得到一串「主题：… 时间：…」，人话都算不上。
  // 只留「主题：」后那段，后面的时间地点由 due/due_time 字段负责表达。
  let base = t
    .replace(/^(主题|课程|活动|会议)[：:]\s*/, '')
    .replace(/\s*(时间|地点|对象|主讲|主办)[：:].*$/, '')
    .trim();

  // 长句只取第一个分句：
  // 「明天的参观活动由副班张弘毅同学负责带队，请大家到位后及时找到副班和负责的老师，不要走散」
  // 整段塞进标题就是一条 40 字长条，手机上一行显示不完，前面真正有用的信息也被淹了。
  // 取第一个有实义的分句（≥6 字），后面的附带要求交给正文存档去查。
  if (base.length > 30) {
    const first = base
      .split(/[，,。；;]/)
      .map((x) => x.trim())
      .find((x) => x.length >= 6);
    if (first) base = first;
  }

  const stripped = stripLeadAndTime(
    base
      // 邮箱要在 @mention 之前处理：@\S+ 会把 @163.com 整段当成人名吃掉
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
      .replace(/@\S+/g, ' ')
      // 「明天的/今天的」这类时间修饰由 LEAD_PREFIX 在 stripLeadAndTime 里剥掉
      .replace(/^(大家|各位|同学们|同学)?(早|早上好|上午好|晚上好)[，,]?\s*/, '')
      .replace(/^为[^，,]{0,25}[，,]\s*/, '')
      .replace(/【\s*】/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );

  return stripped
    // 结尾的客套与催促：「…，别迟到」「…，收到请回复」
    .replace(
      /[，,、\s]*(?:请|麻烦)?(?:全体|各位|所有)?(?:同学)?(?:务必|请)?(?:准时|按时)参加[^\n]{0,4}$/g,
      ''
    )
    .replace(
      /[，,、\s]*(别迟到|不要迟到|务必准时|准时参加|按时参加|请准时|谢谢配合|感谢配合|收到请回复|收到请扣1)[\s!！。.~～]*$/g,
      ''
    )
    .replace(/(哈+|呀|哦|噢|喔|呢|吧|啦|嘛|哟|感谢配合|谢谢大家|谢谢)[\s!！。.~～]*$/g, '')
    .replace(/[\s，,。、：:；;【】[\]]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .replace(/[\s，,。、：:；;]+$/g, '');
}

export function inferTodoByRules(text, { mentions = [], base = new Date(), diagnose } = {}) {
  // diagnose 是个可选的「黑匣子」：传一个空对象进来，被丢弃时这里会写上原因。
  // 起因是群里 7 条通知一条都没入库，而日志里只有「收到」没有「为什么没收」，
  // 我连复盘的材料都没有。抽取失败必须留下理由，否则规则永远没法调。
  const miss = (reason) => {
    if (diagnose) diagnose.reason = reason;
    return null;
  };

  const raw = String(text || '').trim();
  if (!raw) return miss('空消息');
  if (/^[#＃]待办/.test(raw)) return miss('显式指令，不重复抽取');

  // 公众号/新闻转发几乎都以链接开头：「https://mp.weixin… 关于举办…大赛的通知」
  // 以前只要以 http 开头就整条丢掉，等于把所有转发通知全屏蔽了。
  // 正确做法是把链接摘掉，看剩下的正文还有没有东西。
  let body = raw;
  if (/^\s*https?:\/\//.test(raw)) {
    body = raw.replace(/https?:\/\/\S+/g, ' ').trim();
    if (body.length < 6) return miss('只有链接，没有正文');
  }

  const t = normalize(body);
  if (t.length < 4) return miss('太短，没有信息量');
  if (t.length > 500) return miss(`太长（${t.length} 字），超过 500 字上限`);
  if (NOISE.test(t)) return miss('命中噪声词（闲聊/表情/应答）');
  // 只有短消息才按问句排除；长通知里夹个问号很正常
  if (t.length <= 60 && /[?？]\s*$/.test(t)) return miss('短问句，不是待办');

  const sentences = splitSentences(t);
  if (!sentences.length) return miss('切不出句子');

  const core = pickCoreSentence(sentences);
  if (!core) return miss('找不到像待办的那一句');

  // 负责人判定，顺序是硬的，不允许上层覆盖：
  //   1) @ 了谁 → 就归谁（最硬的证据）
  //   2) 正文写了职务（「由副班长汇总」「请纪检委员收齐」）→ 归那个职务
  //   3) 前两条都没有，才按事项性质猜
  //   4) 猜不出来 → 空，表示全班一起做
  // 也就是说：通知里写明了谁负责，这里就绝不会再拿猜测去改它。
  const mentionOwner = mentions?.[0]?.username || '';
  const roleOwner = findRoleOwner(t);
  // 只有「完全没写人」时才允许推断，且结果单独打标记，事后能查是猜的还是写明的
  const topicOwner = mentionOwner || roleOwner ? '' : inferOwnerByTopic(t);
  const assignee = mentionOwner || roleOwner || topicOwner;
  const ownerInferred = Boolean(topicOwner);

  // 日期可能写在跟标题不同的那半句里，所以整条消息一起找。
  // base 用消息本身的发送时间，不能是「现在」——否则「今天下午集合」隔几天补录就全错。
  // 但一句里能自己解析出日期时优先用它：「11月21日期中考试，15号18:30答疑」
  // 两个日期并存，整条消息取第一个会把答疑的截止日算到期中考试那天去。
  // 整条消息里挑「最像死线」的那个日期，而不是第一个遇到的
  const due = pickBestDue(t, base) || parseDueDate(core, base);
  // 时刻必须在 due 同一句、且紧贴这个日期，不能拿整句里随便一个时刻顶上
  const dueTime = timeInSameSentence(sentences, due, base);

  const hasAction = ACTION_WORDS.test(core) || ACTION_WORDS.test(t);
  const hasEvent = EVENT_WORDS.test(t);
  const hasDeadline = DEADLINE_WORDS.test(t);
  const hasImperative = IMPERATIVE_WORDS.test(t);
  const hasPendingSignal = PENDING_WORDS.test(t);

  // 推断出来的负责人不算「有人被指派」，不能靠它把一条闲聊捞进库
  const assigned = Boolean(mentionOwner || roleOwner);
  const recognized =
    (hasAction && (Boolean(due) || assigned)) ||
    ((hasEvent || hasDeadline) && Boolean(due)) ||
    // 「近期可能有实验课，注意一下」这类：事情确定会发生，日期还没定。
    // 收进来当「日期待定」，推 3 期后自动退场。不收的话，等通知就等于没通知。
    (hasEvent && hasPendingSignal) ||
    // 「看 CAD 回放」「学生手册自己看」这类长期有效的事：没有截止日，
    // 但确实是该做的，收成 ongoing，推 2 期后自动退场。
    (hasAction && ONGOING_STRONG.test(t)) ||
    // 祈使句兜底：「请/记得 + 动作」即使没写日期也收，
    // 班级群大量通知都是这个句式，漏掉比多收更麻烦。限长度，避免把长文整段收进来。
    (hasAction && hasImperative && t.length <= 80);
  if (!recognized) {
    return miss(
      `没有可识别的待办结构（动作词=${hasAction ? '有' : '无'}、日期=${due || '无'}、` +
        `被指派的人=${assigned ? '有' : '无'}、事件词=${hasEvent ? '有' : '无'}、期限词=${hasDeadline ? '有' : '无'}）`
    );
  }

  let title = cleanRuleTitle(core);
  // 「请各班纪检委员收齐答题截图」→ 标题里再带一遍职务就是重复
  if (roleOwner && title.startsWith(roleOwner)) {
    title = title.slice(roleOwner.length).replace(/^[\s，,、：:]+/, '');
  }
  if (!title || title.length < 3) return miss(`清洗后标题过短（${title || '空'}）`);

  return {
    title,
    owner: assignee,
    ownerInferred,
    ownerOpenid: mentionOwner ? mentions[0].member_openid || '' : '',
    due,
    dueStart: parseDateRange(t, base)?.start || null,
    dueTime,
    timeState: due ? 'dated' : classifyUndated(t),
  };
}

/**
 * 用模型判断一条普通群消息里有没有待办。
 * 返回 { title, owner, due } 或 null。
 */
export async function inferTodo(text, { mentions = [], senderName = '', base = new Date() } = {}) {
  if (!llmEnabled()) return null;
  if (!looksLikeTodo(text)) return null;

  const hintPeople = mentions.map((m) => m.username).filter(Boolean);
  const baseIso = toISODate(base);
  const prompt = [
    {
      role: 'system',
      content: [
        '你是群聊待办抽取器。判断给到的这条群消息是否包含「需要某个具体的人在未来去做」的事项。',
        '只输出 JSON，不要解释。格式：{"todos":[{"title":"","owner":"","due":"YYYY-MM-DD或null","due_time":"HH:mm或null"}]}',
        '规则：',
        '1. 闲聊、提问、通知、已经完成的事、纯情绪表达，一律不抽。',
        '2. title 用动宾短语，去掉语气词，不超过 30 字。',
        '3. owner 填「谁负责」：@ 到的人写人名；原文用职务指派的（学委、纪检委员、副班长、寝室长、助辅等）原样写职务；确实是面向全班的才填空字符串。',
        '4. due 只在消息里有明确时间指向时填写，否则 null。只到日粒度就填 due_time 为 null；明确提到了具体钟点（如「下午3点」「18:30」）才填 due_time。',
        `5. 消息发送时间是 ${baseIso}，「今天/明天/下周三」这些相对说法一律以这一天为基准换算，不要用别的日期。`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `发送者：${senderName || '未知'}\n被@的人：${
        hintPeople.join('、') || '无'
      }\n消息内容：${text}`,
    },
  ];

  try {
    const raw = await chat(prompt, { maxTokens: 400 });
    const data = extractJson(raw);
    const items = Array.isArray(data) ? data : data?.todos;
    if (!Array.isArray(items) || items.length === 0) return null;

    const first = items[0];
    if (!first?.title) return null;

    const due =
      first.due && /^\d{4}-\d{2}-\d{2}$/.test(first.due)
        ? first.due
        : parseDueDate(text, base);

    return {
      title: String(first.title).slice(0, 60),
      owner: String(first.owner || hintPeople[0] || '').slice(0, 30),
      ownerOpenid: '',
      due,
      dueStart: parseDateRange(text, base)?.start || null,
      dueTime:
        first.due_time && /^\d{2}:\d{2}$/.test(first.due_time)
          ? first.due_time
          : parseTime(text),
      timeState: due ? 'dated' : classifyUndated(text),
    };
  } catch (err) {
    log.debug(`模型抽取失败，跳过：${err.message}`);
    return null;
  }
}
