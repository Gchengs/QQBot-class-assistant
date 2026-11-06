import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * 按事项性质推断负责人——只用来兜底。
 *
 * 这里有一条铁律：**任何明确的指派都优先**。
 *   @了谁        → 谁
 *   正文写职务   → 那个职务（「请副班长汇总」「由纪检委员收齐」）
 *   上面都没有   → 才查这张表
 *   表里也没有   → 空，周报里显示〔全体〕
 *
 * 所以这张表永远不该去覆盖通知里写明的负责人。它只负责回答
 * 「通知没写谁，但这件事班里惯例归谁」。
 *
 * 表可以改：在 data/owner-rules.json 写一个数组，会整个替换掉默认值。
 *   [ { "keywords": ["学籍", "交助辅"], "role": "副班长" } ]
 * 关键词用「包含」匹配，不用写正则，顺序有意义（越具体越往上放）。
 */
const FILE = () => path.join(config.dataDir, 'owner-rules.json');

/**
 * 默认表：只收录班里分工几乎没有争议的。
 * 「班会归班长」这种有争议的一律不放——猜错比不猜更糟，
 * 猜错会让真正的负责人以为这件事跟自己无关。
 */
const DEFAULT_RULES = [
  // 学籍、材料汇总、往上交的东西，班里通常是副班长在跑
  { keywords: ['学籍', '材料汇总', '收齐材料', '汇总后交', '交助辅', '汇总交'], role: '副班长' },
  { keywords: ['青年大学习', '团费', '团员', '团课', '团组织', '推优', '智慧团建'], role: '团支书' },
  { keywords: ['心理普查', '心理测评', '心理健康', '心理班会'], role: '心理委员' },
  { keywords: ['体测', '运动会', '晨跑', '球赛', '篮球赛', '拔河', '体育比赛'], role: '体育委员' },
  { keywords: ['公众号', '推文', '海报', '宣传稿', '展板'], role: '宣传委员' },
  // 「卫生」「值日」不归这里：有的班归生活委员，有的班归纪检委员查寝，猜不准就归全体
  { keywords: ['班费', '维修', '医保', '助学金', '物资'], role: '生活委员' },
  { keywords: ['签到', '考勤', '请假', '晚自习', '查寝', '纪律'], role: '纪检委员' },
  { keywords: ['选课', '评教', '教材', '四六级', '成绩单', '重修'], role: '学习委员' },
  { keywords: ['志愿', '社会实践', '公益活动'], role: '组织委员' },
  { keywords: ['晚会', '节目', '合唱', '汇演', '才艺'], role: '文艺委员' },
];

let cache = null;

/** 读生效中的规则：有 data/owner-rules.json 就用它，否则用默认表 */
export function ownerRules() {
  if (cache) return cache;
  let list = DEFAULT_RULES;
  try {
    const f = FILE();
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const arr = Array.isArray(raw) ? raw : raw?.rules;
      if (Array.isArray(arr) && arr.length) {
        list = arr
          .filter((x) => x && Array.isArray(x.keywords) && x.role)
          .map((x) => ({ keywords: x.keywords.map(String), role: String(x.role) }));
      }
    }
  } catch {
    // 配置文件写坏了就退回默认表，不能让一条格式错误把整条抽取链带崩
    list = DEFAULT_RULES;
  }
  cache = list;
  return cache;
}

/**
 * 按内容推断负责人。
 * 只在通知里完全没写职务时调用；命中就返回职务名，没命中返回空（= 全体）。
 */
export function inferOwnerByTopic(text) {
  const t = String(text || '');
  if (!t) return '';
  for (const rule of ownerRules()) {
    if (rule.keywords.some((k) => k && t.includes(k))) return rule.role;
  }
  return '';
}

/** 规则文件路径，CLI 里打给用户看 */
export function ownerRulesPath() {
  return FILE();
}
