/**
 * 敏感信息体检：防止本机真实数据被误提交。
 *
 * 起因很具体：这个项目最初是给一个真实班级群跑的，`.env` 里有 AppID/AppSecret，
 * `data/` 里有真实群 openid 和聊天原文。开源前人工清过一遍，但人工清是会漏的，
 * 尤其是后面新增文件的时候。所以把「不能出现什么」写成规则，交给机器每次提交查。
 *
 * 只查仓库里应当公开的文件，`.env`、`data/*.json` 这些由 .gitignore 挡住，
 * 真被提交进来反而会被 git 层面的检查抓到，这里只管内容特征。
 *
 * 用法：node scripts/check-secrets.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 不参与扫描的目录 / 文件 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.github']);
const SKIP_FILE = /\.(tar\.gz|png|jpg|jpeg|gif|ico|zip|woff2?)$/i;

/**
 * data/ 下的真实数据由 .gitignore 挡住，不用扫；
 * 但 *.example.json 是要提交的示例文件，必须扫——真有人把 todos.json 直接改名成
 * todos.example.json 提交上去，泄露的就是整份群 openid。
 */
function skipFile(rel) {
  return /^data\//.test(rel) && /\.json$/i.test(rel) && !/\.example\.json$/i.test(rel);
}

/**
 * 规则分两类：
 * - block：一旦命中就失败，属于绝不能进仓库的东西
 * - warn：只提示，多半是文档里的举例，需要人看一眼
 */
const RULES = [
  {
    name: '私有 IP / 公网 IP',
    level: 'block',
    // 127.0.0.1、0.0.0.0 是合法写法，别的四段数字一律可疑
    re: /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
  {
    name: 'QQ 群 / 用户 openid（32 位大写十六进制）',
    level: 'block',
    re: /\b[0-9A-F]{32}\b/g,
  },
  {
    name: '超长数字 ID（16 位以上）',
    level: 'block',
    // QQ 官方错误码是 8 位，不会被这条命中
    re: /\b\d{16,}\b/g,
  },
  {
    name: '邮箱地址',
    level: 'warn',
    re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi,
  },
  {
    name: '疑似密钥 / 私钥',
    level: 'block',
    re: /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKID[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY)/g,
  },
  {
    name: '内网主机名',
    level: 'warn',
    re: /\biZ[a-z0-9]{12,}\b/g,
  },
];

/** 这些值是示例占位或公开常量，不算泄露 */
const ALLOW = new Set([
  'GROUP_OPENID_EXAMPLE',
  '127.0.0.1',
  '0.0.0.0',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (!SKIP_FILE.test(entry.name)) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replaceAll('\\', '/');
  if (skipFile(rel)) continue;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  text.split('\n').forEach((line, i) => {
    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags);
      let m;
      while ((m = re.exec(line))) {
        const val = m[0];
        if (ALLOW.has(val)) continue;
        // 依赖版本号形如 3.0.3，只有三段，不会命中 IP；这条兜底防未来出岔子
        if (rule.name.includes('IP') && /^\d+(\.\d+){3}$/.test(val)) {
          const parts = val.split('.').map(Number);
          if (parts.every((n) => n <= 30) && /package(-lock)?\.json$/.test(rel)) continue;
        }
        hits.push({ rel, line: i + 1, rule: rule.name, level: rule.level, val });
      }
    }
  });
}

const blocked = hits.filter((h) => h.level === 'block');
const warned = hits.filter((h) => h.level === 'warn');

for (const h of hits) {
  const tag = h.level === 'block' ? '✗ 泄露' : '! 待确认';
  console.log(`${tag}  ${h.rel}:${h.line}  [${h.rule}]  ${h.val}`);
}

if (!hits.length) {
  console.log('✓ 没有发现疑似敏感信息');
} else {
  console.log('');
  if (warned.length) console.log(`提示 ${warned.length} 处，需人工判断是否为文档举例`);
  if (blocked.length) console.log(`阻断 ${blocked.length} 处，必须处理`);
}

process.exit(blocked.length ? 1 : 0);
