#!/usr/bin/env bash
# 倪海厦中医问诊 · 服务器部署脚本（宝塔 / 通用 Linux）
#
# 用法（服务器上执行）：
#   bash <(curl -fsSL https://raw.githubusercontent.com/youniszhang/nihaixia/main/app/deploy/install.sh)
# 或克隆后：
#   cd /root/nihaixia/app && bash deploy/install.sh
#
# 交互式填写必填项，生成 .env，启动 Docker 服务。
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

echo "========================================"
echo " 倪海厦中医问诊 · 服务器部署"
echo " 目录: $APP_DIR"
echo "========================================"

# ---- 环境检查 ----
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ 未检测到 Docker。请先在宝塔「软件商店」安装 Docker，或执行："
  echo "   curl -fsSL https://get.docker.com | sh && systemctl enable --now docker"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "❌ 未检测到 Docker Compose。请在宝塔软件商店安装 Docker Compose。"
  exit 1
fi
echo "✅ Docker: $(docker --version | head -c 40)"
echo "✅ Compose: $DC"

# ---- 生成 .env ----
if [ -f .env ]; then
  echo "ℹ️  .env 已存在，跳过生成（如需修改请直接编辑 $APP_DIR/.env）"
else
  read -rp "1) DeepSeek / OpenAI 兼容服务的 API Key: " LLM_KEY
  read -rp "2) 站点访问地址（如 https://tcm.example.com，直接 IP 访问则填 http://你的IP）: " PUB_URL
  read -rp "3) 反向代理模式？(宝塔反代填 y，本机直接对外 80/443 填 n) [y/n]: " BEHIND_PROXY
  read -rp "4) 启用一键更新功能？[y/n]: " ENABLE_UPDATER

  APP_SECRET="$(openssl rand -hex 32)"
  HTTP_PORT=18080
  HTTPS_PORT=18443
  DOMAIN="localhost"
  COOKIE_SECURE=true
  UPDATER_LINES=""

  if [ "$BEHIND_PROXY" = "n" ]; then
    HTTP_PORT=80
    HTTPS_PORT=443
    if [ -n "$PUB_URL" ]; then
      DOMAIN="${PUB_URL#http://}"
      DOMAIN="${DOMAIN#https://}"
      DOMAIN="${DOMAIN%%/*}"
      DOMAIN="${DOMAIN%%:*}"
    fi
  else
    # 反代模式：必须用 ":80"（只监听明文 HTTP，接受任意 Host）。
    # 若留 localhost，Caddy 会按站点自动启用 HTTPS 并把所有请求 308 跳到 https，
    # 反代后端拿到的是重定向而非响应。
    DOMAIN=":80"
  fi

  if [ "$ENABLE_UPDATER" = "y" ]; then
    UPD_TOKEN="$(openssl rand -hex 32)"
    UPDATER_LINES="UPDATER_TOKEN=$UPD_TOKEN
UPDATER_URL=http://updater:8765"
    echo "   已生成更新令牌（勿泄露）"
  fi

  if [ "$BEHIND_PROXY" = "y" ] && [[ "$PUB_URL" == https://* ]]; then
    COOKIE_SECURE=true
  elif [[ "$PUB_URL" == http://* ]]; then
    COOKIE_SECURE=false
  fi

  cat > .env <<ENVEOF
# 由 install.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')
LLM_API_KEY=$LLM_KEY
APP_SECRET=$APP_SECRET
DOMAIN=$DOMAIN
COOKIE_SECURE=$COOKIE_SECURE
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
$UPDATER_LINES
ENVEOF
  chmod 600 .env
  echo "✅ 已生成 $APP_DIR/.env"
fi

# ---- 启动 ----
echo ""
echo "▶ 构建并启动服务（首次约 3-8 分钟）…"
if grep -q "^UPDATER_TOKEN=" .env 2>/dev/null; then
  $DC --profile updater up -d --build
else
  $DC up -d --build
fi

echo ""
echo "▶ 等待服务就绪…"
# 注意：不能 curl /health —— Caddy 只代理 /api/*，/health 会落到 SPA 静态文件返回 200（假阳性）。
# 改为等 api 容器 healthcheck 报 healthy，再请求真实 API 路径确认链路。
PORT="${HTTP_PORT:-18080}"
READY=0
for i in $(seq 1 60); do
  CID="$($DC ps -q api 2>/dev/null | head -1)"
  if [ -n "$CID" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$CID" 2>/dev/null)" = "healthy" ]; then
    CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/sessions" 2>/dev/null || echo 000)"
    if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then
      echo "✅ 服务已就绪（/api/sessions → HTTP $CODE）"
      READY=1
      break
    fi
  fi
  sleep 3
done
if [ "$READY" != "1" ]; then
  echo "⚠️ 服务未在预期时间内就绪，最近 api 日志："
  $DC logs --tail=30 api 2>&1 | tail -30
fi

echo ""
echo "========================================"
echo " 部署完成"
echo "----------------------------------------"
PORT="${HTTP_PORT:-18080}"
if [ "$PORT" = "80" ]; then
  echo " 访问地址: ${PUB_URL:-http://服务器IP}"
else
  echo " 本机入口: http://127.0.0.1:$PORT"
  echo " 对外访问: 在宝塔「网站 → 反向代理」指向 http://127.0.0.1:$PORT"
fi
echo ""
echo " 首次使用: 打开站点注册账号（第一个账号自动成为管理员）"
echo " 模型配置: 登录后侧边栏「⚙️ 模型设置」"
echo " 系统更新: 侧边栏「🔄 系统更新」（已启用 updater 时）"
echo "========================================"
