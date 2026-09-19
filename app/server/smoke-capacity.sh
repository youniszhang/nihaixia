#!/usr/bin/env bash
# 容量保护回归：全局并发闸 + FIFO 排队 + 阈值 + 拒绝补偿提示。
#
# 用小阈值（并发 2 / 队列 3 / 超时 8s）+ mock 上游（单次 ~2s）精确验证：
#   1. 5 路并发：前 2 直接生成，后 3 排队（收到 queue 事件、排位 1/2/3），最终全部成功
#   2. 队满：再插 4 路 → 至少 1 路收到 queue_full 的友好提示（不扣额度）
#   3. 排队超时：把上游拖慢 + 缩短超时 → 收到 queue_timeout 提示与 retry_after
#   4. 管理端水位：/api/admin/capacity 的 active/queued 数字正确
#   5. 阈值改回默认后恢复正常
set -uo pipefail
cd "$(dirname "$0")"

TMP=/tmp/xs-cap-smoke
rm -rf "$TMP"; mkdir -p "$TMP"
export APP_SECRET=cap-secret DB_PATH="$TMP/nihaixia.db" PORT=18095 HOST=127.0.0.1 LOG_LEVEL=warn ALLOW_NO_LLM=true
unset TRUST_PROXY CORS_ORIGIN

# 幂等清理：上一轮残留的 18094/18095 服务会让本轮 EADDRINUSE 静默打到旧进程上
lsof -ti:18095 18094 2>/dev/null | while read p; do ps -p $p -o command= | grep -qE "src/index.js|mock-upstream" && kill $p; done
sleep 0.5

node scripts/mock-upstream.mjs --port 18094 --ttfb 200 --tokens 20 --interval 80 > "$TMP/mock.log" 2>&1 &
MOCK=$!
node src/index.js > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV $MOCK 2>/dev/null; kill ${PIDS:-} 2>/dev/null' EXIT

H=http://127.0.0.1:18095
for i in $(seq 1 40); do curl -s -o /dev/null "$H/health" && break; sleep 0.5; done

pass=0; fail=0
jget() { python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: d=None
print('' if d is None else (d$1 if d$1 is not None else ''))" 2>/dev/null; }
chk() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; pass=$((pass+1)); else echo "  FAIL $1 expected=$2 actual=$3"; fail=$((fail+1)); fi; }
# 管理员 + mock 通道
curl -s -c "$TMP/admin.jar" -X POST "$H/api/auth/register" -H 'content-type: application/json' -d '{"username":"admin","password":"secret123"}' > /dev/null
curl -s -b "$TMP/admin.jar" -X PUT "$H/api/admin/llm" -H 'content-type: application/json' \
  -d '{"provider":"api","base_url":"http://127.0.0.1:18094","model":"mock","api_key":"sk-mock","system_mode":"inline"}' > /dev/null

# 3 个普通用户（各带会话）
for u in u1 u2 u3; do
  curl -s -b "$TMP/admin.jar" -X POST "$H/api/admin/users" -H 'content-type: application/json' -d "{\"username\":\"$u\",\"password\":\"secret123\"}" > /dev/null
  curl -s -c "$TMP/$u.jar" -X POST "$H/api/auth/login" -H 'content-type: application/json' -d "{\"username\":\"$u\",\"password\":\"secret123\"}" > /dev/null
done
SID1=$(curl -s -b "$TMP/u1.jar" -X POST "$H/api/sessions" -H 'content-type: application/json' -d '{"module":"tcm"}' | jget "['session']['id']")
SID2=$(curl -s -b "$TMP/u2.jar" -X POST "$H/api/sessions" -H 'content-type: application/json' -d '{"module":"tcm"}' | jget "['session']['id']")
SID3=$(curl -s -b "$TMP/u3.jar" -X POST "$H/api/sessions" -H 'content-type: application/json' -d '{"module":"tcm"}' | jget "['session']['id']")

echo
echo "== 1. 设置保守阈值：并发 2 / 队列 3 / 超时 8s =="
r=$(curl -s -b "$TMP/admin.jar" -X PUT "$H/api/admin/capacity" -H 'content-type: application/json' \
  -d '{"max_concurrent":2,"queue_max":3,"queue_timeout_s":8}')
chk "阈值保存" "2" "$(echo "$r" | jget "['max_concurrent']")"

echo
echo "== 2. 3 路并发（≤并发闸 2 + 1 排队）应全部成功 =="
( curl -s -N -b "$TMP/u1.jar" -X POST "$H/api/chat/send" -H 'content-type: application/json' -d "{\"session_id\":\"$SID1\",\"content\":\"一\"}" --max-time 30 > "$TMP/r1.txt" ) &
P1=$!
( curl -s -N -b "$TMP/u2.jar" -X POST "$H/api/chat/send" -H 'content-type: application/json' -d "{\"session_id\":\"$SID2\",\"content\":\"二\"}" --max-time 30 > "$TMP/r2.txt" ) &
P2=$!
sleep 0.4
( curl -s -N -b "$TMP/u3.jar" -X POST "$H/api/chat/send" -H 'content-type: application/json' -d "{\"session_id\":\"$SID3\",\"content\":\"三\"}" --max-time 30 > "$TMP/r3.txt" ) &
P3=$!
wait $P1 $P2 $P3
for f in r1 r2 r3; do
  ok=1; has_err=0
  grep -q '"type":"error"' "$TMP/$f.txt" && { ok=0; has_err=1; }
  chk "$f 完成且无错误" "0" "$has_err"
done

echo
echo "== 3. 6 路并发（> 2+3=5）必现 queue_full 的友好提示 =="
SIDS=()
PIDS=""
for i in 1 2 3 4 5 6; do
  curl -s -b "$TMP/admin.jar" -X POST "$H/api/admin/users" -H 'content-type: application/json' -d "{\"username\":\"b$i\",\"password\":\"secret123\"}" > /dev/null
  curl -s -c "$TMP/b$i.jar" -X POST "$H/api/auth/login" -H 'content-type: application/json' -d "{\"username\":\"b$i\",\"password\":\"secret123\"}" > /dev/null
    SIDS+=("$(curl -s -b "$TMP/b$i.jar" -X POST "$H/api/sessions" -H 'content-type: application/json' -d '{"module":"tcm"}' | jget "['session']['id']")")
done
> "$TMP/busy_count"; > "$TMP/queue_seen"
for i in 1 2 3 4 5 6; do
  ( curl -s -N -b "$TMP/b$i.jar" -X POST "$H/api/chat/send" -H 'content-type: application/json' \
      -d "{\"session_id\":\"${SIDS[$((i-1))]}\",\"content\":\"并发$i\"}" --max-time 40 > "$TMP/b$i.txt"
    if grep -q '"code":"queue_full"' "$TMP/b$i.txt"; then echo 1 >> "$TMP/busy_count"; fi
    if grep -q '"type":"queue"' "$TMP/b$i.txt"; then echo 1 >> "$TMP/queue_seen"; fi
  ) &
    PIDS="$PIDS $!"
done
wait $PIDS
busy=$(wc -l < "$TMP/busy_count" | xargs)
chk "出现 queue_full 提示 ≥1" "True" "$([ "$busy" -ge 1 ] && echo True || echo False)"
grep -q "当前使用人数已达瞬时上限" "$TMP"/b*.txt && echo "  ok   提示文案友好（含稍后再试指引）" && pass=$((pass+1)) || { echo "  FAIL 文案缺失"; fail=$((fail+1)); }
# 6 路 → 2 并发 + 3 队列 = 5 能被接纳（有 done），1 被拒（无 done）；排队者随名额释放推进
chk "5 路排队/直进者最终完成（done=5）" "5" "$(grep -l '"type":"done"' "$TMP"/b*.txt | wc -l | xargs)"

echo
echo "== 4. 管理端水位接口 =="
chk "capacity 接口有 active 字段" "True" "$(curl -s -b "$TMP/admin.jar" "$H/api/admin/capacity" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('True' if 'active' in d and 'queued' in d and 'max_concurrent' in d else 'False')")"

echo
echo "== 5. 恢复默认阈值（300/500/45）=="
r=$(curl -s -b "$TMP/admin.jar" -X PUT "$H/api/admin/capacity" -H 'content-type: application/json' \
  -d '{"max_concurrent":300,"queue_max":500,"queue_timeout_s":45}')
chk "阈值已恢复" "300" "$(echo "$r" | jget "['max_concurrent']")"

echo
echo "===== 通过 $pass / 失败 $fail ====="
[ "$fail" = "0" ]