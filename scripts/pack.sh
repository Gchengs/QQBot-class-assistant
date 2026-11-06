#!/usr/bin/env bash
# 打包成单文件上传包（含依赖，服务器上不用再联网装包）
# 用法：bash scripts/pack.sh [输出文件名]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-qqbot-class-assistant.tar.gz}"

# 只打必要文件；data 里已有真实数据，一起带走免得服务器上重新导入
FILES=(src scripts deploy package.json .env data courses.txt todos.txt README.md)
[ -f package-lock.json ] && FILES+=(package-lock.json)
[ -f .env.example ] && FILES+=(.env.example)
[ -d node_modules ] || { echo "缺少 node_modules，先跑 npm install"; exit 1; }
FILES+=(node_modules)

tar --exclude='data/_*' --exclude='*.tmp' -czf "$OUT" "${FILES[@]}"

echo "已生成 ${OUT}（$(du -h "$OUT" | cut -f1)）"
echo ""
echo "包里包含 .env，里面有 AppSecret，别传网盘或发群里。"
echo "上传：scp ${OUT} root@你的服务器IP:/tmp/"
