#!/usr/bin/env bash
# 安全回归冒烟：把 2026-09-18 安全审计出的问题钉成可复跑的用例。
#
# 覆盖：
#   1. 管理员名不可被大小写变体抢注（提权）
#   2. API Key 不泄露（上游错误体回显 Authorization 时，用户侧只有错误编号）
#   3. 管理员接口只回掩码；掩码值不得覆盖真实 Key
#   4. 安全响应头（CSP / no-store / HSTS 条件下发）
#   5. CORS 默认关闭（跨域站点拿不到 ACAO）
#   6. 内部通道默认拒绝（无令牌/错令牌）
#   7. 统一错误出口不泄堆栈
#   8. 子进程 env 白名单（脚本看不到服务端密钥）
#   9. 数据库文件权限 0600
#  10. 会话背景（pin）可保存
#  11. 账号维度失败节流（单元）
#  12. 伪造 X-Forwarded-For 无法绕过限流（放最后跑：会锁本机出口）
#
# 用法：bash smoke-security.sh
set -uo pipefail
cd "$(dirname "$0")"

TMP=/tmp/xs-sec-smoke
rm -rf "$TMP"; mkdir -p "$TMP"
export APP_SECRET=sec-smoke-secret
export DB_PATH="$TMP/nihaixia.db"
export PORT=18097
export HOST=127.0.0.1
export LOG_LEVEL=silent
export ADMIN_USERNAME=alice
export ALLOW_NO_LLM=true
unset TRUST_PROXY CORS_ORIGIN CORS_ALLOW_ANY

echo "== node $(node -v) =="
node src/index.js > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; kill ${EVIL:-0} 2>/dev/null' EXIT

H=http://127.0.0.1:18097
code=""
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$H/health" || true)
  [ "$code" = "200" ] && break; sleep 0.5
done
if [ "${code:-}" != "200" ]; then echo "!! 服务未起来"; tail -20 "$TMP/server.log"; exit 1; fi

pass=0; fail=0
chk() { # chk <desc> <expect> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; pass=$((pass+1));
  else echo "  FAIL $1 expected=$2 actual=$3"; fail=$((fail+1)); fi
}
has() { # has <desc> <needle> <haystack>
  case "$3" in *"$2"*) echo "  ok   $1"; pass=$((pass+1));;
    *) echo "  FAIL $1 未包含 '$2'（实际: $(echo "$3" | head -c 160)）"; fail=$((fail+1));; esac
}
hasnot() { # hasnot <desc> <needle> <haystack>
  case "$3" in *"$2"*) echo "  FAIL $1 不应包含 '$2'（实际: $(echo "$3" | head -c 200)）"; fail=$((fail+1));;
    *) echo "  ok   $1"; pass=$((pass+1));; esac
}
jget() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: d=None
print('' if d is None else (d$1 if d$1 is not None else ''))" 2>/dev/null; }

echo
echo "== 1. 管理员名不可被大小写变体抢注（提权） =="
r=$(curl -s -X POST "$H/api/auth/register" -H 'content-type: application/json' -d '{"username":"ALICE","password":"secret123"}')
has "注册 ALICE 被拒（保留名）" '"error":"username_reserved"' "$r"
r=$(curl -s -c "$TMP/admin.jar" -X POST "$H/api/auth/register" -H 'content-type: application/json' -d '{"username":"alice","password":"secret123"}')
has "注册 alice（精确拼写）成功且为管理员" '"is_admin":true' "$r"
r=$(curl -s -X POST "$H/api/auth/register" -H 'content-type: application/json' -d '{"username":"Alice","password":"secret123"}')
hasnot "大小写变体 Alice 未创建成功" '"user"' "$r"
hasnot "大小写变体 Alice 未拿到管理员" '"is_admin":true' "$r"

echo
echo "== 2. 造一个普通用户（管理员后台建号 + 登录，放在爆破用例之前） =="
curl -s -b "$TMP/admin.jar" -X POST "$H/api/admin/users" -H 'content-type: application/json' \
  -d '{"username":"bob","password":"secret123"}' > /dev/null
r=$(curl -s -c "$TMP/u.jar" -X POST "$H/api/auth/login" -H 'content-type: application/json' -d '{"username":"bob","password":"secret123"}')
has "bob 登录成功" '"username":"bob"' "$r"

echo
echo "== 3. API Key 不泄露给用户（上游错误体回显 Authorization） =="
cat > "$TMP/evil.mjs" <<'EOF'
import http from 'node:http';
http.createServer((req, res) => {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'boom', request_headers: { authorization: req.headers.authorization || '' } }));
}).listen(18098);
EOF
node "$TMP/evil.mjs" > /dev/null 2>&1 &
EVIL=$!
sleep 1
curl -s -b "$TMP/admin.jar" -X PUT "$H/api/admin/llm" -H 'content-type: application/json' \
  -d '{"provider":"api","base_url":"http://127.0.0.1:18098","model":"m","api_key":"sk-SUPERSECRET-KEY-12345"}' > /dev/null
SID=$(curl -s -b "$TMP/u.jar" -X POST "$H/api/sessions" -H 'content-type: application/json' -d '{"module":"tcm"}' | jget "['session']['id']")
resp=$(curl -s -N -b "$TMP/u.jar" -X POST "$H/api/chat/send" -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SID\",\"content\":\"你好\"}" --max-time 20)
hasnot "用户侧看不到 API Key" "SUPERSECRET" "$resp"
hasnot "用户侧看不到 Bearer" "Bearer" "$resp"
has "错误里带可追查编号" "错误编号" "$resp"
persisted=$(curl -s -b "$TMP/u.jar" "$H/api/sessions/$SID" | jget "['messages']")
hasnot "会话记录里不落密钥" "SUPERSECRET" "$persisted"

echo
echo "== 4. 管理员接口只回掩码；掩码不得覆盖真实 Key =="
r=$(curl -s -b "$TMP/admin.jar" "$H/api/admin/llm")
hasnot "/api/admin/llm 不回明文 Key" "SUPERSECRET" "$r"
has "只回掩码" "****" "$r"
r=$(curl -s -b "$TMP/admin.jar" -X PUT "$H/api/admin/llm" -H 'content-type: application/json' -d '{"api_key":"sk-1****abcd"}')
has "拒绝提交掩码值" '"error":"masked_key"' "$r"
r=$(curl -s -b "$TMP/admin.jar" "$H/api/admin/llm")
# 掩码应仍反映原 Key（sk-S...2345），而不是被提交的掩码串（sk-1****abcd）覆盖
has "拒绝后掩码仍指向原 Key" "2345" "$r"
hasnot "未把提交的掩码串当成新 Key" "abcd" "$r"

echo
echo "== 5. 安全响应头 =="
h=$(curl -s -D - -o /dev/null "$H/api/auth/config" | tr 'A-Z' 'a-z')
has "CSP 下发" "content-security-policy" "$h"
has "API 响应 no-store" "no-store" "$h"
has "X-Content-Type-Options" "x-content-type-options" "$h"
hasnot "HTTP 直连不下发 HSTS" "strict-transport-security" "$h"
h2=$(curl -s -D - -o /dev/null -H 'X-Forwarded-Proto: https' "$H/api/auth/config" | tr 'A-Z' 'a-z')
has "经 HTTPS 代理时下发 HSTS" "strict-transport-security" "$h2"

echo
echo "== 6. CORS 默认关闭 =="
h3=$(curl -s -D - -o /dev/null -H 'Origin: https://evil.example.com' "$H/api/auth/config" | tr 'A-Z' 'a-z')
hasnot "不回跨域许可（无 ACAO）" "access-control-allow-origin" "$h3"

echo
echo "== 7. 内部通道默认拒绝 =="
chk "无令牌 → 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$H/internal/dsweb-inject" -H 'content-type: application/json' -d '{"token":"x"}')"
chk "错令牌 → 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$H/internal/dsweb-inject" -H 'x-internal-token: wrong' -H 'content-type: application/json' -d '{"token":"x"}')"

echo
echo "== 8. 统一错误出口 =="
r=$(curl -s -X POST "$H/api/auth/login" -H 'content-type: application/json' -d '{bad json')
hasnot "非法 JSON 不回堆栈" "at " "$r"
has "非法 JSON 有可读原因" '"error"' "$r"
chk "非法 JSON 状态码 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$H/api/auth/login" -H 'content-type: application/json' -d '{bad json')"

echo
echo "== 9. 子进程 env 白名单（且脚本仍能跑） =="
if grep -q "function scriptEnv" src/modules/tools.js && ! grep -q "env: { ...process.env }" src/modules/tools.js; then
  echo "  ok   tools.js 用 env 白名单（不再透传 process.env）"; pass=$((pass+1))
else
  echo "  FAIL tools.js 仍在透传完整 process.env"; fail=$((fail+1))
fi
# 用探针脚本替换排盘脚本，确认子进程确实拿不到服务端密钥（验证完删掉探针目录即可）
mkdir -p "$TMP/probe"
cat > "$TMP/probe/bazi_pai_pan.py" <<'EOF'
import json, os
print(json.dumps({k: v for k, v in os.environ.items() if k in ("LLM_API_KEY", "APP_SECRET", "INTERNAL_TOKEN")}))
EOF
leak=$(LLM_API_KEY=sk-LEAKME APP_SECRET=leakme-secret INTERNAL_TOKEN=leakme-token XUANSHU_SCRIPTS_DIR="$TMP/probe" node --input-type=module -e "
const t = await import('./src/modules/tools.js');
process.stdout.write((await t.baziPaiPan({ solar: '1990-05-15', sex: '男' })).trim());
" 2>/dev/null)
chk "子进程看不到服务端密钥" "{}" "$leak"

echo
echo "== 10. 数据库文件权限 =="
perm=$(stat -f '%Lp' "$DB_PATH" 2>/dev/null || stat -c '%a' "$DB_PATH" 2>/dev/null)
chk "db 文件为 600" "600" "$perm"

echo
echo "== 11. 会话背景（pin）可保存 =="
SID2=$(curl -s -b "$TMP/u.jar" -X POST "$H/api/sessions" -H 'content-type: application/json' -d '{"module":"tcm"}' | jget "['session']['id']")
curl -s -b "$TMP/u.jar" -X PATCH "$H/api/sessions/$SID2" -H 'content-type: application/json' -d '{"pin":"主诉：测试背景"}' > /dev/null
got=$(curl -s -b "$TMP/u.jar" "$H/api/sessions/$SID2" | jget "['session'].get('pin','')")
chk "pin 持久化" "主诉：测试背景" "$got"

echo
echo "== 12. 账号维度失败节流（单元；不依赖 IP） =="
unit=$(node --input-type=module -e "
const t = await import('./src/lib/throttle.js');
const k = 'acct:unit-test';
for (let i = 0; i < 5; i++) t.recordLoginFailure(k);
const locked = t.loginLockRemaining(k) > 0;
t.clearLoginFailures(k);
const cleared = t.loginLockRemaining(k) === 0;
console.log(locked && cleared ? 'ok' : 'bad');
" 2>/dev/null)
chk "连续 5 次失败即锁定；成功后清零" "ok" "$unit"

echo
echo "== 13. 伪造 X-Forwarded-For 无法绕过限流（放最后：会锁本机出口） =="
c=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$H/api/auth/login" -H 'content-type: application/json' \
    -H "X-Forwarded-For: 10.9.9.${i}" -d '{"username":"ghost","password":"wrong"}')
  [ "$code" = "429" ] && c=$((c + 1))
done
if [ "$c" -gt 0 ]; then echo "  ok   伪造 XFF 仍被拦截（429 x${c}）"; pass=$((pass+1));
else echo "  FAIL 伪造 XFF 绕过了限流（0 次 429）"; fail=$((fail+1)); fi

echo
echo "===== 通过 $pass / 失败 $fail ====="
[ "$fail" = "0" ]