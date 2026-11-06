#!/usr/bin/env bash
# 覆盖式更新：只替换 src，保留 data/、.env、课程与待办
#
# 用法（在服务器上）：
#   bash /tmp/upd/deploy/update.sh
# 可选环境变量：
#   APP_DIR=/opt/qqbot-class-assistant  SERVICE=qqbot-class-assistant  OWNER=qqbot
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/qqbot-class-assistant}"
SERVICE="${SERVICE:-qqbot-class-assistant}"
OWNER="${OWNER:-qqbot}"
PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NEW_SRC="$PKG_ROOT/src"
TS="$(date +%Y%m%d-%H%M%S)"

echo "==> 检查"
[ -d "$APP_DIR" ] || { echo "找不到 $APP_DIR（先用 deploy/install.sh 装一次）"; exit 1; }
[ -d "$NEW_SRC" ] || { echo "包内没有 src 目录：$NEW_SRC"; exit 1; }
[ -f "$APP_DIR/.env" ] || echo "注意：$APP_DIR/.env 不存在，稍后会提示"

echo "==> 备份旧代码与配置到 /root/qqbot-class-assistant-src-$TS.tar.gz"
tar -czf "/root/qqbot-class-assistant-src-$TS.tar.gz" -C "$APP_DIR" src .env 2>/dev/null || true

echo "==> 替换 src（旧目录留作 src.old）"
rm -rf "$APP_DIR/src.old"
[ -d "$APP_DIR/src" ] && mv "$APP_DIR/src" "$APP_DIR/src.old"
cp -r "$NEW_SRC" "$APP_DIR/src"

echo "==> 补齐 .env 中缺失的新配置项（已有值一律不覆盖）"
if [ -f "$PKG_ROOT/.env.example" ]; then
  if [ ! -f "$APP_DIR/.env" ]; then
    cp "$PKG_ROOT/.env.example" "$APP_DIR/.env"
    echo "   .env 不存在，已按模板新建（需要填 AppID/AppSecret）"
  else
    added=0
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      key="${line%%=*}"
      key="$(printf '%s' "$key" | tr -d '[:space:]')"
      [ -z "$key" ] && continue
      if ! grep -q "^${key}=" "$APP_DIR/.env"; then
        printf '%s\n' "$line" >> "$APP_DIR/.env"
        echo "   + $key"
        added=$((added + 1))
      fi
    done < "$PKG_ROOT/.env.example"
    [ "$added" -eq 0 ] && echo "   没有需要补的项"
  fi
fi

chown -R "$OWNER:$OWNER" "$APP_DIR/src" 2>/dev/null || true
chmod 600 "$APP_DIR/.env" 2>/dev/null || true

echo "==> 语法检查"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
find "$APP_DIR/src" -name '*.js' -print0 | xargs -0 -n1 "$NODE_BIN" --check || {
  echo "语法检查失败，正在回滚"
  rm -rf "$APP_DIR/src"
  mv "$APP_DIR/src.old" "$APP_DIR/src"
  exit 1
}

echo "==> 重启服务"
systemctl restart "$SERVICE"
sleep 3
systemctl is-active "$SERVICE" && echo "   服务在跑" || echo "   服务没起来，看下面日志"

echo ""
echo "==> 最近 20 行日志"
journalctl -u "$SERVICE" -n 20 --no-pager || true

echo ""
echo "==> 自检"
su -s /bin/sh "$OWNER" -c "cd $APP_DIR && $NODE_BIN src/cli.js doctor" 2>/dev/null || \
  (cd "$APP_DIR" && "$NODE_BIN" src/cli.js doctor) || true

echo ""
echo "完成。确认无误后可删旧目录：rm -rf $APP_DIR/src.old"
