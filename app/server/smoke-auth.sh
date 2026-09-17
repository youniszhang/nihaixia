#!/usr/bin/env bash
# 本地冒烟测试：注册默认关闭 + 注册校验 + 登录不做格式校验
set -uo pipefail
cd "$(dirname "$0")"

TMP=/tmp/nhx-auth-test
rm -rf "$TMP"; mkdir -p "$TMP"
export APP_SECRET=smoke-secret
export DB_PATH="$TMP/nihaixia.db"
export PORT=18099
export HOST=127.0.0.1
export COOKIE_SECURE=false
export LOG_LEVEL=silent
unset REGISTRATION_ENABLED

echo "== node $(node -v) =="
node src/index.js > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:18099/health" || true)
  [ "$code" = "200" ] && break
  sleep 0.5
done
echo "server health: ${code:-none}"
if [ "${code:-}" != "200" ]; then echo "!! 服务未起来"; tail -20 "$TMP/server.log"; exit 1; fi

B=http://127.0.0.1:18099/api/auth
pass=0; fail=0
chk() { # chk <desc> <expect> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; pass=$((pass+1));
  else echo "  FAIL $1 expected=$2 actual=$3"; fail=$((fail+1)); fi
}

echo
echo "== 1. 空库：公开配置（空库必须允许建首个账号，故此时 reported=true）=="
cfg=$(curl -s $B/config); echo "  $cfg"
chk "bootstrap=true（空库）" "true" "$(echo "$cfg" | grep -o '"bootstrap":[a-z]*' | cut -d: -f2)"
chk "registration_enabled=true（bootstrap 例外）" "true" "$(echo "$cfg" | grep -o '"registration_enabled":[a-z]*' | cut -d: -f2)"

echo
echo "== 2. 注册仍做格式校验（用户名 1 位、密码 3 位应被拒）=="
chk "bad_username" "bad_username" "$(curl -s -X POST $B/register -H 'content-type: application/json' -d '{"username":"a","password":"secret123"}' | grep -o '"error":"[a-z_]*"' | cut -d'"' -f4)"
chk "bad_password" "bad_password" "$(curl -s -X POST $B/register -H 'content-type: application/json' -d '{"username":"alice","password":"123"}' | grep -o '"error":"[a-z_]*"' | cut -d'"' -f4)"

echo
echo "== 3. 空库 bootstrap 注册合法账号 =="
chk "register alice = 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/register -H 'content-type: application/json' -d '{"username":"alice","password":"secret123"}')"

echo
echo "== 4. 库非空后：默认关闭 ⇒ 自助注册被拒 =="
resp=$(curl -s -X POST $B/register -H 'content-type: application/json' -d '{"username":"bob","password":"secret123"}')
echo "  $resp"
chk "registration_closed" "registration_closed" "$(echo "$resp" | grep -o '"error":"[a-z_]*"' | cut -d'"' -f4)"
cfg=$(curl -s $B/config)
chk "config.bootstrap=false（已有用户）" "false" "$(echo "$cfg" | grep -o '"bootstrap":[a-z]*' | cut -d: -f2)"

echo
echo "== 5. 登录不做格式校验：造一个「1 位用户名 + 3 位口令」的遗留账号，应能登录 =="
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './src/lib/password.js';
const db = new DatabaseSync(process.env.DB_PATH);
const hash = await hashPassword('abc');
db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('x', hash);
db.close();
console.log('  legacy user x / abc inserted');
"
chk "legacy 账号登录 = 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/login -H 'content-type: application/json' -d '{"username":"x","password":"abc"}')"
chk "错误口令 = 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/login -H 'content-type: application/json' -d '{"username":"alice","password":"wrongpass"}')"
chk "空用户名 = 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/login -H 'content-type: application/json' -d '{"username":"","password":"abc"}')"

echo
echo "== 6. 环境变量仍可显式开启（REGISTRATION_ENABLED=true）=="
kill $SRV 2>/dev/null; sleep 1
REGISTRATION_ENABLED=true node src/index.js >> "$TMP/server.log" 2>&1 &
SRV=$!
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:18099/health" || true)
  [ "$code" = "200" ] && break; sleep 0.5
done
cfg=$(curl -s $B/config); echo "  $cfg"
chk "env=true ⇒ registration_enabled=true" "true" "$(echo "$cfg" | grep -o '"registration_enabled":[a-z]*' | cut -d: -f2)"

echo
echo "===== 通过 $pass / 失败 $fail ====="
[ "$fail" = "0" ]
