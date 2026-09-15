#!/usr/bin/env bash
# 倪海厦中医问诊 · 服务器部署（宝塔 / 通用 Linux，非交互）
#
# 用法（服务器上执行）：
#   NIHAIXIA_ENV_B64="$(base64 < .env)" bash server-deploy.sh
#   或先放好 <仓库>/app/.env 后直接执行
#
# 环境变量：
#   REPO / BRANCH / ROOT   仓库、分支、根目录（默认 github / main / /root）
#   NIHAIXIA_ENV_B64       base64 编码的 .env 内容（存在则写入，覆盖）
set -uo pipefail

REPO="${REPO:-https://github.com/youniszhang/nihaixia.git}"
BRANCH="${BRANCH:-main}"
ROOT="${ROOT:-/root}"
REPO_DIR="$ROOT/nihaixia"
APP_DIR="$REPO_DIR/app"

log() { echo "[$(date '+%F %T')] $*"; }

log "===== nihaixia 服务器部署开始 ====="

# ---- 1. 环境检查 ----
command -v docker >/dev/null 2>&1 || { log "❌ 未安装 Docker（宝塔软件商店 → Docker）"; exit 1; }
command -v git >/dev/null 2>&1 || { log "❌ 未安装 git"; exit 1; }
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  log "❌ 缺少 Docker Compose"; exit 1
fi
log "✅ $(docker --version 2>&1 | head -1)"
log "✅ $($DC version 2>&1 | head -1)"

# ---- 2. 同步代码（确定性：fetch + checkout -B，不用 pull）----
if [ -d "$REPO_DIR/.git" ]; then
  cd "$REPO_DIR" || exit 1
  log "▶ git fetch + checkout $BRANCH"
  git fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" --prune \
    || { log "❌ git fetch 失败（服务器无法访问 GitHub）"; exit 1; }
  git checkout -B "$BRANCH" "origin/$BRANCH" \
    || { log "❌ git checkout 失败（可能有未提交改动）"; exit 1; }
else
  log "▶ git clone $REPO"
  git clone --branch "$BRANCH" "$REPO" "$REPO_DIR" \
    || { log "❌ git clone 失败（服务器无法访问 GitHub）"; exit 1; }
fi
cd "$APP_DIR" || exit 1
log "✅ 代码: $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"

# ---- 3. 写 .env ----
if [ -n "${NIHAIXIA_ENV_B64:-}" ]; then
  printf '%s' "$NIHAIXIA_ENV_B64" | base64 -d > .env
  chmod 600 .env
  log "✅ 已从 NIHAIXIA_ENV_B64 写入 .env"
fi
if [ ! -f .env ]; then
  log "❌ 缺少 $APP_DIR/.env"
  exit 1
fi
log "✅ .env 就绪（$(wc -l < .env) 行）"

# ---- 4. 构建 + 启动 ----
log "▶ docker compose up -d --build（首次约 3-8 分钟）…"
# 兼容旧版本遗留的固定容器名（nihaixia-updater）——先清掉，避免重建时撞名
docker rm -f nihaixia-updater >/dev/null 2>&1 || true
rc=0
if grep -q '^UPDATER_TOKEN=' .env 2>/dev/null; then
  $DC --profile updater up -d --build --remove-orphans || rc=$?
else
  $DC up -d --build --remove-orphans || rc=$?
fi
if [ "$rc" -ne 0 ]; then
  log "❌ 构建/启动失败（exit=$rc）"
  $DC ps 2>&1 | tail -20
  exit 1
fi
log "✅ 容器已启动"
$DC ps 2>&1 | tail -10

# ---- 5. 健康检查 ----
# 注意：不能直接 curl /health —— Caddy 只代理 /api/*，/health 会落到 SPA 静态文件，
# 永远返回 200（假阳性）。这里改为等 api 容器的 compose healthcheck 报告 healthy，
# 再经 Caddy 请求一个真实 API 路径确认反代链路（未登录返回 401 即证明 api 有响应）。
PORT="$(grep -E '^HTTP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)"
PORT="${PORT:-18080}"

log "▶ 等待 api 容器 healthy…"
ok=0
st="unknown"
for i in $(seq 1 48); do
  cid="$($DC ps -q api 2>/dev/null | head -1)"
  if [ -n "$cid" ]; then
    st="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"
    if [ "$st" = "healthy" ]; then ok=1; break; fi
  fi
  sleep 5
done
if [ "$ok" != "1" ]; then
  log "❌ api 容器未就绪（最后状态: $st）"
  $DC logs --tail=60 api 2>&1 | tail -60
  exit 1
fi
log "✅ api 容器 healthy"

code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/lan-info" 2>/dev/null || echo 000)"
case "$code" in
  200|401) log "✅ Caddy → api 链路正常（/api/lan-info → HTTP $code）" ;;
  000)     log "❌ 无法连接 http://127.0.0.1:$PORT（web 容器未监听？）"; exit 1 ;;
  *)       log "⚠️ 反代链路异常（/api/lan-info → HTTP $code），请检查 Caddy/防火墙"; exit 1 ;;
esac

log "===== 部署成功 ====="
log "本机入口: http://127.0.0.1:$PORT"
log "下一步：宝塔「网站 → 反向代理」指向 http://127.0.0.1:$PORT，并申请 SSL"
exit 0
