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

# ---- HTTP 探针：只信 3 位状态码 ----
# curl 连接失败时会输出 "000" 且退出码非零；若写成 `curl ... || echo 000`，
# 两者会被拼接成 "000000"，让 `[ "$code" = "000" ]` 这类判断失效——
# 2026-09-19 01:32 的部署就因此把「连接全断」误报成「✅ 链路恢复（HTTP 000000）」。
probe_code() {
  local out
  out="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true)"
  case "$out" in
    [1-5][0-9][0-9]) printf '%s' "$out" ;;
    *) printf '000' ;;
  esac
}

API_PROBE_URL() { echo "http://127.0.0.1:$PORT/api/sessions"; }

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
  log "❌ 构建/启动失败（exit=${rc}）"
  # 已发生过的事故（2026-09-17 及此前多次）：compose 重建 web 时报
  # "No such container: <id>" —— 旧容器已删、新容器被 docker 丢弃，
  # 18080 无人监听，整站 502 且无人补救。这里单独补起 web 再复查。
  #
  # 2026-09-19 两次实测的失败形态（都在这一步）：
  #   ① No such image: app-updater:latest（updater 建了镜像却没打上 tag）
  #   ② Conflict. The container name "/app-updater-1" is already in use（旧容器没清干净）
  # 两者重跑一次即可；故这里是「清理 + 重试」，不是直接放弃。
  log "↩  清理可能残留的 updater 容器并重试一次…"
  stale="$($DC --profile updater ps -aq updater 2>/dev/null || true)"
  if [ -n "$stale" ]; then
    # shellcheck disable=SC2086
    docker rm -f $stale >/dev/null 2>&1 || true
    log "   已清理残留容器: $(echo $stale | tr '\n' ' ')"
  fi
  rc2=0
  if grep -q '^UPDATER_TOKEN=' .env 2>/dev/null; then
    $DC --profile updater up -d --build --remove-orphans || rc2=$?
  else
    $DC up -d --build --remove-orphans || rc2=$?
  fi
  if [ "$rc2" -eq 0 ]; then log "✅ 重试后构建/启动成功"; else log "⚠️ 重试仍失败（exit=${rc2}），继续恢复入口容器"; fi

  log "↩  复查入口容器 web…"
  $DC up -d web 2>&1 | tail -5
  code="$(probe_code "$(API_PROBE_URL)")"
  for i in $(seq 1 12); do
    [ "$code" != "000" ] && break
    sleep 5
    code="$(probe_code "$(API_PROBE_URL)")"
  done
  if [ "$code" = "000" ]; then
    log "❌ 无法连接 $(API_PROBE_URL)"
    $DC ps -a 2>&1 | tail -20
    exit 1
  fi
  log "✅ 经自愈后链路恢复（/api/sessions → HTTP ${code}）"
  $DC ps 2>&1 | tail -10

  # 站点可用 ≠ 全部就绪。2026-09-19 01:32 的教训：updater 容器没起来（镜像缺 tag），
  # 但自愈分支只看入口探针就打了「部署成功」，十小时后才发现「一键更新」一直 fetch failed。
  # 这里显式复查 updater，缺失就如实报「部分成功」并以非零码退出，别让日志说谎。
  if grep -q '^UPDATER_TOKEN=' .env 2>/dev/null; then
    ucid="$($DC --profile updater ps -q updater 2>/dev/null | head -1)"
    ust=""
    [ -n "$ucid" ] && ust="$(docker inspect --format '{{.State.Status}}' "$ucid" 2>/dev/null || echo unknown)"
    if [ "$ust" != "running" ]; then
      log "⚠️  站点已恢复，但更新容器 updater 未就绪（状态: ${ust:-未创建}）——应用内「一键更新」会失败。"
      log "    手工修复：cd $APP_DIR && docker compose --profile updater up -d --build updater"
      log "===== 部署部分成功（入口已恢复，更新容器缺失） ====="
      exit 1
    fi
    log "✅ updater 容器 running"
  fi

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
  log "❌ api 容器未就绪（最后状态: ${st}）"
  $DC logs --tail=60 api 2>&1 | tail -60
  exit 1
fi
log "✅ api 容器 healthy"

code="$(probe_code "$(API_PROBE_URL)")"
case "$code" in
  200|401) log "✅ Caddy → api 链路正常（/api/sessions → HTTP ${code}）" ;;
  000)
    # 已发生过的事故：web（入口/Caddy）容器整个不在（被清理或重建失败），
    # 此时整站 502 而 api 仍健康 —— 只重建入口容器即可恢复。
    log "⚠️ 无法连接 http://127.0.0.1:${PORT}，尝试重建入口容器 web…"
    $DC up -d web 2>&1 | tail -5
    for i in $(seq 1 12); do
      sleep 5
      code="$(probe_code "$(API_PROBE_URL)")"
      [ "$code" != "000" ] && break
    done
    if [ "$code" = "000" ]; then
      log "❌ 入口容器 web 仍未监听 127.0.0.1:$PORT"
      log "   请检查 .env 的 HTTP_PORT（当前 ${PORT}）以及该端口是否被占用："
      $DC ps -a 2>&1 | tail -20
      exit 1
    fi
    log "✅ 重建入口容器后链路恢复（/api/sessions → HTTP ${code}）"
    ;;
  *)       log "⚠️ 反代链路异常（/api/sessions → HTTP ${code}），请检查 Caddy/防火墙"; exit 1 ;;
esac

# updater 就绪复查（同自愈分支的说明：站点活着 ≠ 一键更新可用）
if grep -q '^UPDATER_TOKEN=' .env 2>/dev/null; then
  ucid="$($DC --profile updater ps -q updater 2>/dev/null | head -1)"
  ust=""
  [ -n "$ucid" ] && ust="$(docker inspect --format '{{.State.Status}}' "$ucid" 2>/dev/null || echo unknown)"
  if [ "$ust" != "running" ]; then
    log "⚠️  站点已就绪，但更新容器 updater 未运行（状态: ${ust:-未创建}）——应用内「一键更新」不可用。"
    log "    手工修复：cd $APP_DIR && docker compose --profile updater up -d --build updater"
    log "===== 部署部分成功（站点可用，更新容器缺失） ====="
    exit 1
  fi
  log "✅ updater 容器 running"
fi

log "===== 部署成功 ====="
log "本机入口: http://127.0.0.1:$PORT"
log "下一步：宝塔「网站 → 反向代理」指向 http://127.0.0.1:${PORT}，并申请 SSL"
exit 0
