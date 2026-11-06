/**
 * 语法检查：把 src 下所有 .js 都过一遍 node --check。
 *
 * 为什么单独写一个脚本，而不是在 CI 里写一段 bash 循环：
 * Windows 本机的默认 shell 不是 bash，写死 bash 语法会让本地和 CI 两边行为不一致。
 * 用 node 写，两边跑的是同一份逻辑。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 不用 import.meta.dirname：它要 Node 20.11+，而项目 engines 写的是 >=18
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(p, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

const targets = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];

let bad = 0;
for (const file of targets) {
  const rel = path.relative(ROOT, file).replaceAll('\\', '/');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    bad += 1;
    console.error(`✗ ${rel}`);
    console.error(String(err.stderr || err.message).trim());
  }
}

if (bad) {
  console.error(`\n${bad} / ${targets.length} 个文件语法有误`);
  process.exit(1);
}
console.log(`✓ ${targets.length} 个文件语法正常`);
