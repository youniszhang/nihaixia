#!/usr/bin/env bash
# 模块权限 × 订阅 回归冒烟（2026-09-18）：把「按模块单独开通 + 订阅附带模块」钉成用例。
#
# 覆盖：
#   1. 新注册/新建用户默认只有中医；8 个模块卡片全部返回（无权限的带 lock_reason）
#   2. 站点未上线的模块：普通用户 lock_reason=offline（连申请都不给）
#   3. 套餐可携带模块：审批通过后用户拿到对应模块（source=plan + 到期时间）
#   4. 订阅到期：模块权限自动失效、卡片回到「无权限」
#   5. 管理员手动开通 = 永久：与订阅并存时不被订阅到期收走
#   6. 撤销可生效：写墓碑，连站点默认的中医也能撤掉（不会被 defaultGrant 兜底救回）
#   7. 后台可改「新用户默认模块」，之后新建账号按新默认发牌
#
# 用法：bash smoke-modules.sh
set -uo pipefail
cd "$(dirname "$0")"

TMP=/tmp/xs-mod-smoke
rm -rf "$TMP"; mkdir -p "$TMP"
export APP_SECRET=mod-smoke-secret
export DB_PATH="$TMP/nihaixia.db"
export PORT=18096
export HOST=127.0.0.1
export LOG_LEVEL=silent
export ADMIN_USERNAME=admin
export ALLOW_NO_LLM=true
unset TRUST_PROXY CORS_ORIGIN

echo "== node $(node -v) =="
node src/index.js > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

H=http://127.0.0.1:18096
code=""
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$H/health" || true)
  [ "$code" = "200" ] && break; sleep 0.5
done
if [ "${code:-}" != "200" ]; then echo "!! 服务未起来"; tail -20 "$TMP/server.log"; exit 1; fi

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; pass=$((pass+1)); else echo "  FAIL $1 expected=$2 actual=$3"; fail=$((fail+1)); fi }
jq_get() { python3 -c "
import json,sys
d=json.load(sys.stdin)
try: print(d$1)
except Exception: print('')"; }

AJ="$TMP/admin.jar"; UJ="$TMP/u.jar"

echo
echo "== 0. 管理员 bootstrap + 造普通用户 =="
curl -s -c "$AJ" -X POST "$H/api/auth/register" -H 'content-type: application/json' -d '{"username":"admin","password":"secret123"}' > /dev/null
chk "管理员注册" "True" "$(curl -s -b "$AJ" "$H/api/auth/me" | jq_get "['user']['is_admin']")"
curl -s -b "$AJ" -X POST "$H/api/admin/users" -H 'content-type: application/json' -d '{"username":"u1","password":"secret123"}' > /dev/null
curl -s -c "$UJ" -X POST "$H/api/auth/login" -H 'content-type: application/json' -d '{"username":"u1","password":"secret123"}' > /dev/null
chk "普通用户登录" "u1" "$(curl -s -b "$UJ" "$H/api/auth/me" | jq_get "['user']['username']")"

echo
echo "== 1. 新用户默认只有中医；8 张卡片全返回 =="
mods=$(curl -s -b "$UJ" "$H/api/modules")
chk "卡片总数 = 8" "8" "$(echo "$mods" | jq_get "['modules'].__len__()")"
chk "可用数量 = 1（仅中医）" "1" "$(echo "$mods" | python3 -c "import json,sys;print(len([m for m in json.load(sys.stdin)['modules'] if m['available']]))")"
chk "中医 grant_source=default" "default" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['grant_source'] for m in json.load(sys.stdin)['modules'] if m['id']=='tcm'))")"
chk "中医会话可建" "tcm" "$(curl -s -b "$UJ" -X POST "$H/api/sessions" -H 'content-type: application/json' -d '{"module":"tcm"}' | jq_get "['session']['module']")"
chk "八字会话被拒（未开通）" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b "$UJ" -X POST "$H/api/sessions" -H 'content-type: application/json' -d '{"module":"bazi"}')"

echo
echo "== 2. 站点未上线 → lock_reason=offline（普通用户看不到申请入口） =="
chk "八字 lock_reason=offline" "offline" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['lock_reason'] for m in json.load(sys.stdin)['modules'] if m['id']=='bazi'))")"

echo
echo "== 3. 上线八字（apply 模式）→ 无权限但可申请 =="
# 站点开关是总闸：套餐即使发牌，站点没上线的模块照样不可用（塔罗在后面会用到，这里一并上线）
curl -s -b "$AJ" -X PATCH "$H/api/admin/modules/bazi" -H 'content-type: application/json' -d '{"site_enabled":true,"open_mode":"apply"}' > /dev/null
curl -s -b "$AJ" -X PATCH "$H/api/admin/modules/tarot" -H 'content-type: application/json' -d '{"site_enabled":true,"open_mode":"apply"}' > /dev/null
mods=$(curl -s -b "$UJ" "$H/api/modules")
chk "上线后 lock_reason=no_grant" "no_grant" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['lock_reason'] for m in json.load(sys.stdin)['modules'] if m['id']=='bazi'))")"
chk "仍不可用" "False" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['available'] for m in json.load(sys.stdin)['modules'] if m['id']=='bazi'))")"

echo
echo "== 4. 套餐携带模块：审批后拿到模块权限（source=plan + 到期） =="
curl -s -b "$AJ" -X POST "$H/api/admin/plans" -H 'content-type: application/json' \
  -d '{"name":"术数双修","period_days":30,"credits":100,"daily_chat_limit":20,"modules":["bazi","tarot"]}' > /dev/null
plan_id=$(curl -s -b "$AJ" "$H/api/admin/plans" | python3 -c "
import json,sys
print(next(p['id'] for p in json.load(sys.stdin)['plans'] if p['name']=='术数双修'))")
chk "套餐含 2 个模块" "2" "$(curl -s -b "$AJ" "$H/api/admin/plans" | python3 -c "
import json,sys
print(len(next(p['modules'] for p in json.load(sys.stdin)['plans'] if p['name']=='术数双修')))")"
curl -s -b "$UJ" -X POST "$H/api/subscription/apply" -H 'content-type: application/json' -d "{\"plan_id\":$plan_id}" > /dev/null
sub_id=$(curl -s -b "$AJ" "$H/api/admin/subscriptions?status=pending" | jq_get "['subscriptions'][0]['id']")
curl -s -b "$AJ" -X POST "$H/api/admin/subscriptions/$sub_id/approve" > /dev/null
mods=$(curl -s -b "$UJ" "$H/api/modules")
chk "八字已可用" "True" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['available'] for m in json.load(sys.stdin)['modules'] if m['id']=='bazi'))")"
chk "八字来源 = plan" "plan" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['grant_source'] for m in json.load(sys.stdin)['modules'] if m['id']=='bazi'))")"
chk "八字带到期时间" "True" "$(echo "$mods" | python3 -c "
import json,sys
print(bool(next(m['grant_expires_at'] for m in json.load(sys.stdin)['modules'] if m['id']=='bazi')))")"
chk "塔罗也已可用" "True" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['available'] for m in json.load(sys.stdin)['modules'] if m['id']=='tarot'))")"
chk "套餐列表含模块明细" "2" "$(curl -s -b "$UJ" "$H/api/subscription" | python3 -c "
import json,sys
print(len(next(p['modules_detail'] for p in json.load(sys.stdin)['plans'] if p['name']=='术数双修')))")"
chk "我的模块权限含 plan 来源" "True" "$(curl -s -b "$UJ" "$H/api/subscription" | python3 -c "
import json,sys
print(any(m['source']=='plan' for m in json.load(sys.stdin)['my_modules']))")"

# 回归：会话列表必须带 module 字段。
# 前端侧栏按 `(x.module || 'tcm') === 当前模块` 过滤；列表漏了 module 会让所有会话
# 都被当成 tcm，非中医模块的「历史记录」整体消失（2026-09-22 生产事故）。
# 之前只验了 POST /api/sessions 的返回，没验 GET /api/sessions，所以漏网。
curl -s -b "$UJ" -X POST "$H/api/sessions" -H 'content-type: application/json' \
  -d '{"module":"bazi","title":"八字回归"}' > /dev/null
sess_list=$(curl -s -b "$UJ" "$H/api/sessions")
chk "列表返回 module（八字会话= bazi）" "bazi" "$(echo "$sess_list" | python3 -c "
import json,sys
s=[x for x in json.load(sys.stdin)['sessions'] if x.get('title')=='八字回归']
print(s[0].get('module','(字段缺失)') if s else '(未找到会话)')")"
chk "列表里 tcm 会话仍是 tcm（未被误标）" "tcm" "$(echo "$sess_list" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print('tcm' if [x for x in ss if x.get('module')=='tcm'] else '(无 tcm 会话)')")"
chk "侧栏过滤口径：八字模块只看到 1 条" "1" "$(echo "$sess_list" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
print(len([x for x in ss if (x.get('module') or 'tcm')=='bazi']))")"

echo
echo "== 5. 管理员手动开通 = 永久（与订阅并存不被到期收走） =="
uid=$(curl -s -b "$AJ" "$H/api/admin/users" | python3 -c "
import json,sys
print(next(u['id'] for u in json.load(sys.stdin)['users'] if u['username']=='u1'))")
curl -s -b "$AJ" -X POST "$H/api/admin/modules/bazi/grant" -H 'content-type: application/json' -d "{\"user_id\":$uid}" > /dev/null
chk "手动开通后来源升级为 manual" "manual" "$(curl -s -b "$UJ" "$H/api/modules" | python3 -c "
import json,sys
print(next(m['grant_source'] for m in json.load(sys.stdin)['modules'] if m['id']=='bazi'))")"

echo
echo "== 6. 订阅到期 → 订阅型权限自动失效（手动的不受影响） =="
# 把订阅到期时间改到过去（直接改库，模拟到期）
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH);
db.prepare(\"UPDATE subscriptions SET expires_at = datetime('now','-1 day') WHERE status='active'\").run();
db.prepare(\"UPDATE user_modules SET expires_at = datetime('now','-1 day') WHERE source='plan'\").run();
" 2>/dev/null
mods=$(curl -s -b "$UJ" "$H/api/modules")
chk "塔罗（订阅型）已失效 → 不可用" "False" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['available'] for m in json.load(sys.stdin)['modules'] if m['id']=='tarot'))")"
chk "塔罗 lock_reason=no_grant" "no_grant" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['lock_reason'] for m in json.load(sys.stdin)['modules'] if m['id']=='tarot'))")"
chk "八字（手动开通）仍可用" "True" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['available'] for m in json.load(sys.stdin)['modules'] if m['id']=='bazi'))")"

echo
echo "== 7. 撤销可生效：连站点默认的中医也能撤掉 =="
curl -s -b "$AJ" -X POST "$H/api/admin/modules/tcm/revoke" -H 'content-type: application/json' -d "{\"user_id\":$uid}" > /dev/null
mods=$(curl -s -b "$UJ" "$H/api/modules")
chk "撤销后中医不可用（墓碑覆盖默认）" "False" "$(echo "$mods" | python3 -c "
import json,sys
print(next(m['available'] for m in json.load(sys.stdin)['modules'] if m['id']=='tcm'))")"
chk "中医会话被拒" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b "$UJ" -X POST "$H/api/sessions" -H 'content-type: application/json' -d '{"module":"tcm"}')"
curl -s -b "$AJ" -X POST "$H/api/admin/modules/tcm/grant" -H 'content-type: application/json' -d "{\"user_id\":$uid}" > /dev/null
chk "重新开通后恢复" "True" "$(curl -s -b "$UJ" "$H/api/modules" | python3 -c "
import json,sys
print(next(m['available'] for m in json.load(sys.stdin)['modules'] if m['id']=='tcm'))")"

echo
echo "== 8. 后台可改新用户默认模块 =="
chk "默认值为 [tcm]" "['tcm']" "$(curl -s -b "$AJ" "$H/api/admin/modules" | jq_get "['default_modules']")"
curl -s -b "$AJ" -X PUT "$H/api/admin/modules-defaults" -H 'content-type: application/json' -d '{"modules":["tcm","bazi"]}' > /dev/null
curl -s -b "$AJ" -X POST "$H/api/admin/users" -H 'content-type: application/json' -d '{"username":"u2","password":"secret123"}' > /dev/null
curl -s -c "$TMP/u2.jar" -X POST "$H/api/auth/login" -H 'content-type: application/json' -d '{"username":"u2","password":"secret123"}' > /dev/null
chk "新用户 u2 拿到 2 个模块（含八字）" "True" "$(curl -s -b "$TMP/u2.jar" "$H/api/modules" | python3 -c "
import json,sys
ms=json.load(sys.stdin)['modules']
print(len([m for m in ms if m['available']])==2 and next(m['available'] for m in ms if m['id']=='bazi'))")"
# 改回默认，避免影响后续手工验证
curl -s -b "$AJ" -X PUT "$H/api/admin/modules-defaults" -H 'content-type: application/json' -d '{"modules":["tcm"]}' > /dev/null

echo
echo "== 9. 管理员名单显示来源 =="
chk "八字名单含 u1（manual）" "manual" "$(curl -s -b "$AJ" "$H/api/admin/modules/bazi/users" | python3 -c "
import json,sys
print(next(u['source'] for u in json.load(sys.stdin)['users'] if u['username']=='u1'))")"

echo
echo "===== 通过 $pass / 失败 $fail ====="
[ "$fail" = "0" ]
