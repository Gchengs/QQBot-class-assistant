#!/usr/bin/env bash
# 在云服务器上跑一次，把机器人装成开机自启的 systemd 服务。
# 用法（必须是 root）：
#   scp qqbot-class-assistant.tar.gz root@服务器IP:/tmp/
#   scp deploy/install.sh     root@服务器IP:/tmp/
#   ssh root@服务器IP 'bash /tmp/install.sh'
set -euo pipefail

PKG="${1:-/tmp/qqbot-class-assistant.tar.gz}"
DIR=/opt/qqbot-class-assistant
RUN_USER=qqbot

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash $0"
  exit 1
fi

if [ ! -f "$PKG" ]; then
  echo "找不到安装包 $PKG"
  echo "先在本地跑 npm run pack，再 scp 上来"
  exit 1
fi

# ---------- 1. Node ----------
# 代码用了全局 fetch，硬性要求 Node >= 18。
# Node 20 已于 2026-04 EOL，这里装 22 LTS（维护到 2027-04）。
NODE_MAJOR=22

if ! command -v node >/dev/null 2>&1; then
  echo ">> 安装 Node.js ${NODE_MAJOR}（NodeSource 官方源）"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y curl ca-certificates
    # 新版本发行版（如 Ubuntu 26.04）NodeSource 可能还没适配，失败了就退回系统源，
    # 后面的版本校验会兜住：只要最终 >= 18 就继续，否则报错退出。
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - || \
      echo "!! NodeSource 源配置失败，退回系统自带 nodejs"
    apt-get install -y nodejs || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    yum install -y nodejs
  else
    echo "!! 没认出包管理器，请手动装 Node 18+ 后重跑"
    exit 1
  fi
fi

# 版本兜底：应用镜像自带的 Node 14/16 没有全局 fetch，装上也是白装，
# 与其让它跑起来再崩，不如在这里直接拦掉。
NODE_VER="$(node -v 2>/dev/null || true)"
NODE_VER="${NODE_VER#v}"
NODE_CUR_MAJOR="${NODE_VER%%.*}"
case "$NODE_CUR_MAJOR" in
  ''|*[!0-9]*) NODE_CUR_MAJOR=0 ;;
esac
if [ "$NODE_CUR_MAJOR" -lt 18 ]; then
  echo "!! 当前 Node 版本是 v${NODE_VER:-未知}，本项目要求 >= 18（用了全局 fetch）"
  echo "   升级后重跑本脚本："
  echo "   curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - && apt-get install -y nodejs"
  exit 1
fi
NODE_BIN="$(command -v node)"
echo ">> Node v${NODE_VER} @ ${NODE_BIN}"

# ---------- 2. 运行用户与目录 ----------
if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd -r -m -d "$DIR" -s /usr/sbin/nologin "$RUN_USER"
fi

mkdir -p "$DIR"
tar -xzf "$PKG" -C "$DIR"
chown -R "$RUN_USER:$RUN_USER" "$DIR"
# .env 里有 AppSecret
if [ -f "$DIR/.env" ]; then chmod 600 "$DIR/.env"; fi

# ---------- 3. 时区 ----------
# 不是东八区的话 cron 会按 UTC 跑，18:00 的日报会变成凌晨 2:00
if command -v timedatectl >/dev/null 2>&1; then
  timedatectl set-timezone Asia/Shanghai || true
fi

# ---------- 4. systemd ----------
# service 内容内联在这里，不依赖上传包里是否带 deploy/ 目录
cat > /etc/systemd/system/qqbot-class-assistant.service <<UNIT
[Unit]
Description=QQ Group Todo Bot
Documentation=file://${DIR}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${DIR}
ExecStart=${NODE_BIN} src/index.js

# 挂了自动拉起：网络抖动、QQ 网关断开都靠这个兜住
Restart=always
RestartSec=5
# 退出码 78 = 数据版本比程序新。这种情况重试一万次也没用，重启只会刷日志，
# 所以拦住它，让人去升级程序（程序里对应 EXIT_SCHEMA_TOO_NEW）。
RestartPreventExitStatus=78

# 日志进 journald，用 journalctl -u qqbot-class-assistant -f 看
StandardOutput=journal
StandardError=journal
SyslogIdentifier=qqbot-class-assistant

# 时区固定成东八区，否则 cron 会按 UTC 跑，18:00 会变成凌晨 2:00
Environment=TZ=Asia/Shanghai
Environment=NODE_ENV=production

# 基本加固：机器人只往外连，不需要写系统目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${DIR}/data

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now qqbot-class-assistant

sleep 3
echo
echo ">> 服务状态："
systemctl --no-pager --lines=0 status qqbot-class-assistant || true
echo
echo ">> 最近日志："
journalctl -u qqbot-class-assistant -n 20 --no-pager || true
echo
echo "看到「机器人已上线」就成功了。接着去群里 @ 它一次，然后执行："
echo "  sudo -u $RUN_USER bash -c 'cd $DIR && node src/cli.js groups'"
