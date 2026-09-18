#!/usr/bin/env bash
# 玄枢 · 服务器部署（宝塔 / 通用 Linux，非交互）
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
# 注意：NIHAIXIA_ENV_B64 会整体覆盖 .env。为防止把管理员等人工配置冲掉，
# 覆盖前先备份，并把旧文件里的手工配置项（ADMIN_USERNAME / REGISTRATION_ENABLED）
# 补回新文件（仅在旧值非空且新文件未显式设置时）。
env_preserve() {
  local key="$1"
  if [ ! -f "$APP_DIR/.env" ]; then return 0; fi
  local cur
  cur="$(grep -E "^${key}=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  [ -z "$cur" ] && return 0
  if grep -qE "^${key}=.+" "$APP_DIR/.env.tmp" 2>/dev/null; then return 0; fi
  printf '\n# 由部署脚本保留（原 .env 中的手工配置）\n%s=%s\n' "$key" "$cur" >> "$APP_DIR/.env.tmp"
  log "↩  已保留原配置 $key=$cur"
}

if [ -n "${NIHAIXIA_ENV_B64:-}" ]; then
  if [ -f .env ]; then
    cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
    log "🗄  已备份原 .env"
  fi
  printf '%s' "$NIHAIXIA_ENV_B64" | base64 -d > .env.tmp
  # HTTP_PORT / HTTPS_PORT 必须保留：部署会整体覆盖 .env，若内嵌的那份没写这俩，
  # compose 会退回默认 80/443，与宝塔 nginx 抢端口 → web 容器起不来、整站不可用。
  for k in ADMIN_USERNAME REGISTRATION_ENABLED LLM_API_KEY LLM_BASE_URL LLM_MODEL \
           HTTP_PORT HTTPS_PORT DOMAIN UPDATER_TOKEN TZ; do
    env_preserve "$k"
  done
  mv .env.tmp .env
  chmod 600 .env
  log "✅ 已从 NIHAIXIA_ENV_B64 写入 .env"
fi
if [ ! -f .env ]; then
  log "❌ 缺少 $APP_DIR/.env"
  exit 1
fi
log "✅ .env 就绪（$(wc -l < .env) 行）"

# ---- 4. 构建 + 启动 ----
PORT="$(grep -E '^HTTP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)"
PORT="${PORT:-18080}"
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
  # 已发生过的事故（2026-09-17 及此前多次）：compose 重建 web 时报
  # "No such container: <id>" —— 旧容器已删、新容器被 docker 丢弃，
  # 18080 无人监听，整站 502 且无人补救。这里单独补起 web 再复查。
  log "↩  尝试单独补起入口容器 web…"
  $DC up -d web 2>&1 | tail -5
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/sessions" 2>/dev/null || echo 000)"
  for i in $(seq 1 12); do
    [ "$code" != "000" ] && break
    sleep 5
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/sessions" 2>/dev/null || echo 000)"
  done
  if [ "$code" = "000" ]; then
    log "❌ 补起 web 后仍无法连接 http://127.0.0.1:$PORT"
    $DC ps -a 2>&1 | tail -20
    exit 1
  fi
  log "✅ 经自愈后链路恢复（/api/sessions → HTTP $code）"
  $DC ps 2>&1 | tail -10
  log "===== 部署成功（自愈） ====="
  exit 0
fi
log "✅ 容器已启动"
$DC ps 2>&1 | tail -10

# ---- 5. 健康检查 ----
# 注意：不能直接 curl /health —— Caddy 只代理 /api/*，/health 会落到 SPA 静态文件，
# 永远返回 200（假阳性）。这里改为等 api 容器的 compose healthcheck 报告 healthy，
# 再经 Caddy 请求一个真实 API 路径确认反代链路（未登录返回 401 即证明 api 有响应）。

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

code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/sessions" 2>/dev/null || echo 000)"
case "$code" in
  200|401) log "✅ Caddy → api 链路正常（/api/sessions → HTTP $code）" ;;
  000)
    # 已发生过的事故：web（入口/Caddy）容器整个不在（被清理或重建失败），
    # 此时整站 502 而 api 仍健康 —— 只重建入口容器即可恢复。
    log "⚠️ 无法连接 http://127.0.0.1:$PORT，尝试重建入口容器 web…"
    $DC up -d web 2>&1 | tail -5
    for i in $(seq 1 12); do
      sleep 5
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/sessions" 2>/dev/null || echo 000)"
      [ "$code" != "000" ] && break
    done
    if [ "$code" = "000" ]; then
      log "❌ 入口容器 web 仍未监听 127.0.0.1:$PORT"
      log "   请检查 .env 的 HTTP_PORT（当前 ${PORT}）以及该端口是否被占用："
      $DC ps -a 2>&1 | tail -20
      exit 1
    fi
    log "✅ 重建入口容器后链路恢复（/api/sessions → HTTP $code）"
    ;;
  *)       log "⚠️ 反代链路异常（/api/sessions → HTTP $code），请检查 Caddy/防火墙"; exit 1 ;;
esac

log "===== 部署成功 ====="
log "本机入口: http://127.0.0.1:$PORT"
log "下一步：宝塔「网站 → 反向代理」指向 http://127.0.0.1:$PORT，并申请 SSL"
exit 0
