#!/usr/bin/env bash
# 冒烟测试：updater /status 的版本检查（此前版本号永远为「—」的回归防护）
#   1) 未显式 check 时：本地版本立即有值，远端为 null（不白等 git fetch）
#   2) check=1 时：实时 fetch，远端版本出现，updateAvailable=false
#   3) 远端有新提交后：updateAvailable=true
#   4) 远端不可达时：checkError 有值且不清空上次的远端版本
set -uo pipefail
cd "$(dirname "$0")"

TMP=/tmp/nhx-updater-test
rm -rf "$TMP"; mkdir -p "$TMP"
WORK="$TMP/work"
REMOTE="$TMP/remote.git"
PORT=18097

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# 造一个「裸远端 + 本地工作库」的最小仓库
git init --bare -q "$REMOTE"
git init -q "$WORK"
cd "$WORK"
git checkout -q -b main
echo one > a.txt
git add . && git commit -qm "first"
git remote add origin "$REMOTE"
git push -qu origin main >/dev/null 2>&1
FIRST=$(git rev-parse --short HEAD)
cd - >/dev/null

UPDATER_TOKEN=smoke-token PROJECT_DIR="$WORK" GIT_BRANCH=main PORT=$PORT \
  node updater/server.mjs > "$TMP/updater.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 30); do
  # updater 全部路由（含 /health）都要 Bearer token，探针必须带上
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer smoke-token' "http://127.0.0.1:$PORT/health" || true)
  [ "$code" = "200" ] && break; sleep 0.3
done
echo "updater health: ${code:-none}"
if [ "${code:-}" != "200" ]; then echo "!! updater 未起来"; cat "$TMP/updater.log"; exit 1; fi

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL $1 expected=$2 actual=$3"; fail=$((fail+1)); fi; }
jqv() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('$1','<missing>'))"; }

H="Authorization: Bearer smoke-token"

echo
echo "== 1. 默认 /status：本地版本即刻有值，不触发 fetch =="
s=$(curl -s -H "$H" "http://127.0.0.1:$PORT/status")
chk "localCommit=$FIRST" "$FIRST" "$(echo "$s" | jqv localCommit)"
chk "remoteCommit 为空（未 check）" "None" "$(echo "$s" | jqv remoteCommit)"
chk "checking=false" "False" "$(echo "$s" | jqv checking)"

echo
echo "== 2. check=1：实时 fetch，远端版本出现且无新提交 =="
s=$(curl -s -H "$H" "http://127.0.0.1:$PORT/status?check=1")
chk "remoteCommit=$FIRST" "$FIRST" "$(echo "$s" | jqv remoteCommit)"
chk "updateAvailable=false" "False" "$(echo "$s" | jqv updateAvailable)"
chk "checkError 为空" "None" "$(echo "$s" | jqv checkError)"
chk "checkedAt 有值" "True" "$(python3 -c "import json,sys;print(bool(json.loads(sys.stdin.read()).get('checkedAt')))" <<< "$s")"

echo
echo "== 3. 远端有新提交：updateAvailable=true =="
CLONE="$TMP/clone"
git clone -q "$REMOTE" "$CLONE"
(cd "$CLONE" && echo two > b.txt && git add . && git commit -qm "second" && git push -q origin main) >/dev/null 2>&1
SECOND=$(cd "$CLONE" && git rev-parse --short HEAD)
s=$(curl -s -H "$H" "http://127.0.0.1:$PORT/status?check=1")
chk "remoteCommit=$SECOND" "$SECOND" "$(echo "$s" | jqv remoteCommit)"
chk "localCommit 仍是 $FIRST" "$FIRST" "$(echo "$s" | jqv localCommit)"
chk "updateAvailable=true" "True" "$(echo "$s" | jqv updateAvailable)"

echo
echo "== 4. 远端不可达：checkError 有值，保留上次远端版本 =="
git -C "$WORK" remote set-url origin "$TMP/nonexistent.git"
s=$(curl -s -H "$H" "http://127.0.0.1:$PORT/status?check=1")
chk "checkError 非空" "True" "$(python3 -c "import json,sys;print(bool(json.loads(sys.stdin.read()).get('checkError')))" <<< "$s")"
chk "remoteCommit 保留上次值" "$SECOND" "$(echo "$s" | jqv remoteCommit)"

echo
echo "== 5. 鉴权：错误 token 403 =="
chk "403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "http://127.0.0.1:$PORT/status")"

echo
echo "== 6. 工作目录不是 git 仓库：自检要给出可读原因（回归：2026-09-17 自更新挂载错误）=="
BROKEN="$TMP/broken"
mkdir -p "$BROKEN"
BROKEN_PORT=18096
UPDATER_TOKEN=smoke-token PROJECT_DIR="$BROKEN" GIT_BRANCH=main PORT=$BROKEN_PORT \
  node updater/server.mjs > "$TMP/updater2.log" 2>&1 &
SRV2=$!
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer smoke-token' "http://127.0.0.1:$BROKEN_PORT/health" || true)
  [ "$code" = "200" ] && break; sleep 0.3
done
s=$(curl -s -H "$H" "http://127.0.0.1:$BROKEN_PORT/status?check=1")
chk "workspaceOk=false" "False" "$(echo "$s" | jqv workspaceOk)"
chk "workspaceError 提到不是 git 仓库" "True" "$(python3 -c "import json,sys;print('不是 git 仓库' in (json.loads(sys.stdin.read()).get('workspaceError') or ''))" <<< "$s")"
chk "localCommit 为空" "None" "$(echo "$s" | jqv localCommit)"
chk "checkError 非空（页面能显示原因）" "True" "$(python3 -c "import json,sys;print(bool(json.loads(sys.stdin.read()).get('checkError')))" <<< "$s")"
kill $SRV2 2>/dev/null

echo
echo "===== 通过 $pass / 失败 $fail ====="
[ "$fail" = "0" ]
