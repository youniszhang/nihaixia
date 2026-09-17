#!/usr/bin/env bash
# 冒烟测试：单点登录（顶号）/ 邀请码注册 / 历史消息分页
set -uo pipefail
cd "$(dirname "$0")"

TMP=/tmp/nhx-feature-test
rm -rf "$TMP"; mkdir -p "$TMP"
export APP_SECRET=smoke-secret
export DB_PATH="$TMP/nihaixia.db"
export PORT=18098
export HOST=127.0.0.1
export COOKIE_SECURE=false
export LOG_LEVEL=silent
# 管理员由 ADMIN_USERNAME 指定（与生产一致）；否则 /admin/* 全 403
export ADMIN_USERNAME=root_admin
unset REGISTRATION_ENABLED

node src/index.js > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:18098/health" || true)
  [ "$code" = "200" ] && break; sleep 0.5
done
echo "server health: ${code:-none}"
[ "${code:-}" = "200" ] || { echo "!! 服务未起来"; tail -20 "$TMP/server.log"; exit 1; }

B=http://127.0.0.1:18098/api
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL $1 expected=$2 actual=$3"; fail=$((fail+1)); fi; }

echo
echo "== 1. 空库首启：允许建管理员（无需邀请码）=="
chk "bootstrap 注册 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/register -H 'content-type: application/json' -d '{"username":"root_admin","password":"secret123"}')"

echo
echo "== 2. 库非空后：默认邀请制 =="
cfg=$(curl -s $B/auth/config); echo "  $cfg"
chk "invite_required=true" "true" "$(echo "$cfg" | grep -o '"invite_required":[a-z]*' | cut -d: -f2)"
resp=$(curl -s -X POST $B/auth/register -H 'content-type: application/json' -d '{"username":"nobody","password":"secret123"}')
chk "无邀请码注册被拒" "registration_closed" "$(echo "$resp" | grep -o '"error":"[a-z_]*"' | cut -d'"' -f4)"

echo
echo "== 3. 管理员生成邀请码（1 次 / 1 天有效）=="
# 用管理员 cookie 登录
curl -s -c "$TMP/admin.jar" -X POST $B/auth/login -H 'content-type: application/json' -d '{"username":"root_admin","password":"secret123"}' -o /dev/null
INV=$(curl -s -b "$TMP/admin.jar" -X POST $B/admin/invites -H 'content-type: application/json' -d '{"max_uses":1,"expires_in_days":1,"note":"smoke"}')
CODE=$(echo "$INV" | grep -o '"code":"[A-Z0-9]*"' | head -1 | cut -d'"' -f4)
echo "  生成邀请码: ${CODE:-none}"
chk "拿到邀请码" "yes" "$([ -n "$CODE" ] && echo yes || echo no)"

echo
echo "== 4. 凭邀请码注册成功 =="
ST4=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/register -H 'content-type: application/json' -d "{\"username\":\"invited_user\",\"password\":\"secret123\",\"invite_code\":\"$CODE\"}")
chk "邀请码注册 200" "200" "$ST4"

echo
echo "== 5. 同一邀请码第二次 = 已用尽 =="
resp=$(curl -s -X POST $B/auth/register -H 'content-type: application/json' -d "{\"username\":\"second_user\",\"password\":\"secret123\",\"invite_code\":\"$CODE\"}")
echo "  $resp"
chk "invite_used" "invite_used" "$(echo "$resp" | grep -o '"error":"[a-z_]*"' | cut -d'"' -f4)"
chk "第二个用户未被创建（401 登录）" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/login -H 'content-type: application/json' -d '{"username":"second_user","password":"secret123"}')"

echo
echo "== 6. 无效邀请码 =="
resp=$(curl -s -X POST $B/auth/register -H 'content-type: application/json' -d '{"username":"third_user","password":"secret123","invite_code":"NOPECODE1234"}')
chk "invite_invalid" "invite_invalid" "$(echo "$resp" | grep -o '"error":"[a-z_]*"' | cut -d'"' -f4)"

echo
echo "== 7. 过期邀请码 =="
EXP=$(curl -s -b "$TMP/admin.jar" -X POST $B/admin/invites -H 'content-type: application/json' -d '{"max_uses":1,"expires_in_days":-1}' | grep -o '"code":"[A-Z0-9]*"' | head -1 | cut -d'"' -f4)
# expires_in_days<=0 会被当作「永久」，这里直接改库制造过期
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync(process.env.DB_PATH);
db.prepare(\"UPDATE invite_codes SET expires_at = datetime('now','-1 day') WHERE code = ?\").run('$EXP');
db.close();" 2>/dev/null
resp=$(curl -s -X POST $B/auth/register -H 'content-type: application/json' -d "{\"username\":\"expired_user\",\"password\":\"secret123\",\"invite_code\":\"$EXP\"}")
chk "invite_expired" "invite_expired" "$(echo "$resp" | grep -o '"error":"[a-z_]*"' | cut -d'"' -f4)"

echo
echo "== 8. 停用邀请码 =="
OFF=$(curl -s -b "$TMP/admin.jar" -X POST $B/admin/invites -H 'content-type: application/json' -d '{"max_uses":1}' | grep -o '"code":"[A-Z0-9]*"' | head -1 | cut -d'"' -f4)
OFFID=$(node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync(process.env.DB_PATH);
console.log(db.prepare('SELECT id FROM invite_codes WHERE code = ?').get('$OFF').id);" 2>/dev/null)
curl -s -b "$TMP/admin.jar" -X PATCH $B/admin/invites/$OFFID -H 'content-type: application/json' -d '{"disabled":true}' -o /dev/null
resp=$(curl -s -X POST $B/auth/register -H 'content-type: application/json' -d "{\"username\":\"off_user\",\"password\":\"secret123\",\"invite_code\":\"$OFF\"}")
chk "invite_disabled" "invite_disabled" "$(echo "$resp" | grep -o '"error":"[a-z_]*"' | cut -d'"' -f4)"

echo
echo "== 9. 单点登录：再次登录顶掉旧会话 =="
curl -s -c "$TMP/dev1.jar" -X POST $B/auth/login -H 'content-type: application/json' -d '{"username":"invited_user","password":"secret123"}' -o /dev/null
chk "设备1 可用" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/dev1.jar" $B/auth/me)"
curl -s -c "$TMP/dev2.jar" -X POST $B/auth/login -H 'content-type: application/json' -d '{"username":"invited_user","password":"secret123"}' -o /dev/null
chk "设备2 可用" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/dev2.jar" $B/auth/me)"
chk "设备1 被顶掉(401)" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/dev1.jar" $B/auth/me)"
chk "设备2 仍可用" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/dev2.jar" $B/auth/me)"

echo
echo "== 10. 历史消息分页 =="
# 用 python 解析 JSON，避免 grep 抓到无关字段（如 last_used_by）
jqget() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
SID=$(curl -s -b "$TMP/dev2.jar" -X POST $B/sessions -H 'content-type: application/json' -d '{"title":"paging"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync(process.env.DB_PATH);
const ins=db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?,?,?)');
for (let i=1;i<=120;i++) ins.run('$SID', i%2? 'user':'assistant', 'msg-'+i);
db.close();" 2>/dev/null
p1=$(curl -s -b "$TMP/dev2.jar" "$B/sessions/$SID?limit=40")
chk "首页 40 条" "40" "$(echo "$p1" | jqget 'len(d["messages"])')"
chk "has_more=true" "true" "$(echo "$p1" | jqget 'str(d["has_more"]).lower()')"
chk "total=120" "120" "$(echo "$p1" | jqget 'd["total"]')"
chk "首页是最后 40 条（从 msg-81 起）" "msg-81" "$(echo "$p1" | jqget 'd["messages"][0]["content"]')"
oldest=$(echo "$p1" | jqget 'd["messages"][0]["id"]')
p2=$(curl -s -b "$TMP/dev2.jar" "$B/sessions/$SID?limit=40&before_id=$oldest")
chk "第二页 40 条" "40" "$(echo "$p2" | jqget 'len(d["messages"])')"
chk "第二页从 msg-41 起" "msg-41" "$(echo "$p2" | jqget 'd["messages"][0]["content"]')"
oldest2=$(echo "$p2" | jqget 'd["messages"][0]["id"]')
p3=$(curl -s -b "$TMP/dev2.jar" "$B/sessions/$SID?limit=40&before_id=$oldest2")
chk "最后一页从 msg-1 起" "msg-1" "$(echo "$p3" | jqget 'd["messages"][0]["content"]')"
chk "最后一页 has_more=false" "false" "$(echo "$p3" | jqget 'str(d["has_more"]).lower()')"

echo
echo "== 11. 越权：不能读别人的会话 =="
SID2=$(node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync(process.env.DB_PATH);
const uid=db.prepare('SELECT id FROM users WHERE username=?').get('root_admin').id;
const r=db.prepare('INSERT INTO sessions (id,user_id,title) VALUES (?,?,?)').run('other-sess',uid,'x');
console.log('other-sess');" 2>/dev/null)
chk "读他人会话 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/dev2.jar" "$B/sessions/other-sess")"

echo
echo "===== 通过 $pass / 失败 $fail ====="
[ "$fail" = "0" ]
