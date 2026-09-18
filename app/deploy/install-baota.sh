#!/usr/bin/env bash
# 玄枢 · 宝塔服务器非交互部署脚本
#
# 供「宝塔面板 → 计划任务 → Shell 脚本」或 SSH 调用。
# .env 内容由外部写入（如 base64 解码），本脚本不接收交互输入。
#
# 用法：
#   cd /root/nihaixia/app && bash deploy/install-baota.sh
#
# 环境变量（可选）：
#   REPO      默认 https://github.com/youniszhang/nihaixia.git
#   BRANCH    默认 main
#   APP_DIR   默认 脚本所在目录的上一级（即 app/）
set -uo pipefail

REPO="${REPO:-https://github.com/youniszhang/nihaixia.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(dirname "$APP_DIR")"

log() { echo "[$(date '+%F %T')] $*"; }

log "===== nihaixia 部署开始 ====="
log "仓库: $REPO (分支 $BRANCH)"
log "目录: $APP_DIR"

# ---- 1. 环境检查 ----
if ! command -v docker >/dev/null 2>&1; then
  log "❌ 未检测到 Docker。请先在宝塔「软件商店」安装 Docker。"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  log "❌ 未检测到 Docker Compose。"
  exit 1
fi
log "✅ Docker: $(docker --version 2>&1 | head -c 60)"
log "✅ Compose: $($DC version 2>&1 | head -c 60)"

# ---- 2. 同步代码（确定性，不用 git pull）----
cd "$REPO_DIR" || { log "❌ 无法进入 $REPO_DIR"; exit 1; }
if [ -d .git ]; then
  log "▶ git fetch + 重置到 origin/$BRANCH"
  git fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" --prune || { log "❌ git fetch 失败（网络或凭据）"; exit 1; }
  git checkout -B "$BRANCH" "origin/$BRANCH" || { log "❌ git checkout 失败"; exit 1; }
  log "✅ 当前提交: $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
else
  log "▶ git clone $REPO"
  git clone --branch "$BRANCH" "$REPO" "$REPO_DIR" || { log "❌ git clone 失败"; exit 1; }
fi
cd "$APP_DIR" || exit 1

# ---- 3. 检查 .env ----
if [ ! -f .env ]; then
  log "❌ 缺少 $APP_DIR/.env，请先生成（见 .env.example）"
  exit 1
fi
log "✅ .env 存在（$(wc -l < .env) 行）"

# ---- 4. 构建 + 启动 ----
log "▶ 构建并启动（首次约 3-8 分钟）…"
if grep -q '^UPDATER_TOKEN=' .env 2>/dev/null; then
  $DC --profile updater up -d --build
else
  $DC up -d --build
fi
rc=$?
if [ $rc -ne 0 ]; then
  log "❌ 构建/启动失败（exit=$rc）"
  $DC ps 2>&1 | tail -20
  exit 1
fi
log "✅ 容器已启动"
$DC ps 2>&1 | tail -10

# ---- 5. 健康检查 ----
PORT="$(grep -E '^HTTP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)"
PORT="${PORT:-18080}"
log "▶ 健康检查 http://127.0.0.1:$PORT/health …"
ok=0
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    ok=1
    log "✅ 服务就绪: $(curl -fsS "http://127.0.0.1:$PORT/health" 2>&1)"
    break
  fi
  sleep 5
done

if [ "$ok" != "1" ]; then
  log "❌ 健康检查超时，最近 api 日志："
  $DC logs --tail=60 api 2>&1 | tail -60
  exit 1
fi

log "===== 部署完成 ====="
log "本机入口: http://127.0.0.1:$PORT"
