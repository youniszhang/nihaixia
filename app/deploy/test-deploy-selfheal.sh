#!/usr/bin/env bash
# server-deploy.sh 部署判据回归测试（2026-09-19 建立，2026-09-20 修订）
#
# 覆盖三个当时真实发生的缺陷：
#   ① 探针拼接：`curl ... || echo 000` 在连接失败时输出 "000000"，与 `= "000"` 比较永不成立
#      → 「整站连不上」被误报成「✅ 链路恢复」并 exit 0
#   ② updater 假成功：站点活着就报「部署成功」，但 updater 容器没起来 → 一键更新静默失效
#   ③ updater 重建竞态：`No such image` / `container name already in use` → 应清理并重试
#
# 用法：bash app/deploy/test-deploy-selfheal.sh
# 退出码：0 = 全绿；1 = 有用例失败
set -uo pipefail

SCRIPT_ABS="$(cd "$(dirname "$0")" && pwd)/server-deploy.sh"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  ✅ $*"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $*"; FAIL=$((FAIL+1)); }

# ---------- 沙箱 ----------
make_stubs() {
  local SB="$1"
  mkdir -p "$SB/bin" "$SB/state"

  cat > "$SB/bin/docker" <<'STUB'
#!/usr/bin/env bash
S="$FAKE_STATE"
bump() { local f="$S/$1" n=0; [ -f "$f" ] && n="$(cat "$f")"; n=$((n+1)); echo "$n" > "$f"; echo "$n"; }

if [ "$1" = "--version" ]; then echo "Docker version 27.0.0, build stub"; exit 0; fi
if [ "$1" = "inspect" ]; then
  # 脚本查两种格式：Health.Status（api 健康）与 State.Status（updater 存活）
  if [[ "$*" == *"State.Health.Status"* ]]; then
    if [ -f "$S/health" ]; then cat "$S/health"; else echo "healthy"; fi
  else
    [ -f "$S/updater-absent" ] || echo "running"
  fi
  exit 0
fi
if [ "$1" = "rm" ]; then echo "removed" ; exit 0; fi

if [ "$1" = "compose" ]; then
  shift
  args="$*"
  case "$args" in
    "version"*) echo "Docker Compose version v2.29.0"; exit 0 ;;
    *"ps -q api"*) echo "cid-api"; exit 0 ;;
    *"ps -q updater"*)
      # updater 容器 ID：状态文件 absent-list 存在时表示「没有容器」
      [ -f "$S/updater-absent" ] && exit 0
      echo "cid-updater"; exit 0 ;;
  esac
  echo "$args" >> "$S/compose.log"
  case "$args" in
    *"up -d"*)
      n="$(bump up)"
      if [ -f "$S/up-fail-until" ] && [ "$n" -le "$(cat "$S/up-fail-until")" ]; then
        echo "service:updater:1 Error response from daemon: No such image: app-updater:latest" >&2
        exit 1
      fi
      exit 0 ;;
  esac
  exit 0
fi
exit 0
STUB
  chmod +x "$SB/bin/docker"

  cat > "$SB/bin/curl" <<'STUB'
#!/usr/bin/env bash
S="$FAKE_STATE"
if [ -f "$S/curl-code" ]; then printf '%s' "$(cat "$S/curl-code")"; exit 0; fi
# 真实 curl 行为：连接失败时 -w '%{http_code}' 仍会打印 "000"，同时退出码非零。
# 这正是 `"$(curl ... || echo 000)"` 得到 "000000" 的成因，必须如实模拟。
printf '000'
exit 7
STUB
  chmod +x "$SB/bin/curl"

  printf '#!/usr/bin/env bash\nexit 0\n' > "$SB/bin/sleep";  chmod +x "$SB/bin/sleep"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$SB/bin/base64"; chmod +x "$SB/bin/base64"
}

# 建一个「看起来像已 clone 好的仓库」的沙箱
make_sandbox() {
  SB="$(mktemp -d /tmp/nhx-deploy-test-XXXXXX)"
  make_stubs "$SB"
  R="$SB/root/nihaixia"
  mkdir -p "$R/app/deploy"
  git -C "$R" init -q
  git -C "$R" config user.email t@t.local
  git -C "$R" config user.name t
  mkdir -p "$SB/remote.git"
  git init -q --bare "$SB/remote.git"
  # 远端要有一个 main 分支，脚本的 fetch + checkout -B main origin/main 才能成功
  local seed="$SB/seed"
  git clone -q "$SB/remote.git" "$seed" 2>/dev/null
  ( cd "$seed" && echo "seed" > README.md && git add -A && git commit -qm "init" && git branch -M main && git push -q origin main )
  git -C "$R" remote add origin "$SB/remote.git"
  git -C "$R" fetch -q origin main
  git -C "$R" checkout -q -B main origin/main
  printf 'HTTP_PORT=18080\nUPDATER_TOKEN=fake-token\nAPP_SECRET=x\n' > "$R/app/.env"
}

run_script() {   # $1=脚本路径  -> 结果放 LAST_OUT / LAST_RC
  LAST_OUT="$(PATH="$SB/bin:$PATH" FAKE_STATE="$SB/state" ROOT="$SB/root" \
              bash "$1" 2>&1)"
  LAST_RC=$?
}

show() { printf '%s\n' "$LAST_OUT" | sed 's/^/    | /' | tail -"${1:-12}"; }

# =====================================================================
echo "======== 用例 1：正常部署（up 成功、探针 401、updater running）========"
make_sandbox
echo 401 > "$SB/state/curl-code"
run_script "$SCRIPT_ABS"
show 10; echo "    -> exit=$LAST_RC"
[ "$LAST_RC" -eq 0 ] && ok "exit 0" || bad "期望 exit 0，实际 $LAST_RC"
grep -q "===== 部署成功 =====" <<<"$LAST_OUT" && ok "报告「部署成功」" || bad "未报告成功"
grep -q "部署成功（自愈）" <<<"$LAST_OUT" && bad "误走自愈分支" || ok "未误走自愈分支"
grep -q "updater 容器 running" <<<"$LAST_OUT" && ok "复查了 updater 就绪" || bad "未复查 updater"
grep -q "000000" <<<"$LAST_OUT" && bad "出现 000000 拼接" || ok "无 000000 拼接"

# =====================================================================
echo ""
echo "======== 用例 2：构建失败一次 → 清理重试成功（自愈）========"
make_sandbox
echo 1 > "$SB/state/up-fail-until"
echo 401 > "$SB/state/curl-code"
run_script "$SCRIPT_ABS"
show 14; echo "    -> exit=$LAST_RC"
[ "$LAST_RC" -eq 0 ] && ok "exit 0（自愈成功）" || bad "期望 exit 0，实际 $LAST_RC"
grep -q "部署成功（自愈）" <<<"$LAST_OUT" && ok "走自愈分支且成功" || bad "未走自愈分支"
grep -qE "经自愈后链路恢复.*HTTP 401" <<<"$LAST_OUT" && ok "报告真实码 401" || bad "未报告 401"
grep -q "重试后构建/启动成功" <<<"$LAST_OUT" && ok "执行了清理重试" || bad "未执行重试"
grep -q "000000" <<<"$LAST_OUT" && bad "出现 000000 拼接" || ok "无 000000 拼接"

# =====================================================================
echo ""
echo "======== 用例 3【回归点①】：构建失败 + 探针恒 000 → 必须 exit≠0 ========"
make_sandbox
echo 2 > "$SB/state/up-fail-until"     # 首次与重试都失败
: > "$SB/state/updater-absent"          # updater 容器不存在
# 不写 curl-code → curl 恒失败（模拟整站连不上）
run_script "$SCRIPT_ABS"
show 12; echo "    -> exit=$LAST_RC"
[ "$LAST_RC" -ne 0 ] && ok "exit 非零（${LAST_RC}）" || bad "期望失败却 exit 0 —— 假阳性！"
grep -q "无法连接" <<<"$LAST_OUT" && ok "明确报告连接失败" || bad "未报告连接失败"
grep -q "经自愈后链路恢复" <<<"$LAST_OUT" && bad "误报「链路恢复」" || ok "未误报链路恢复"
grep -q "000000" <<<"$LAST_OUT" && bad "出现 000000 拼接" || ok "无 000000 拼接"

# =====================================================================
echo ""
echo "======== 用例 4【回归点②】：站点可用但 updater 缺失 → 不得报「部署成功」========"
make_sandbox
echo 401 > "$SB/state/curl-code"        # 站点正常
: > "$SB/state/updater-absent"           # 但 updater 没起来（01:32 真实场景）
run_script "$SCRIPT_ABS"
show 10; echo "    -> exit=$LAST_RC"
[ "$LAST_RC" -ne 0 ] && ok "exit 非零（${LAST_RC}）" || bad "updater 缺失却 exit 0 —— 静默失效！"
grep -q "部署部分成功" <<<"$LAST_OUT" && ok "如实报「部分成功」" || bad "未区分部分成功"
grep -q "updater 未运行\|updater 未就绪" <<<"$LAST_OUT" && ok "明确指出 updater 问题" || bad "未指出 updater 问题"
grep -q "===== 部署成功 =====" <<<"$LAST_OUT" && bad "仍报完全成功" || ok "未报完全成功"

# =====================================================================
echo ""
echo "======== 回退法：分别隔离验证两个缺陷（证明断言有牙）========"
OLD="$SB/old-server-deploy.sh"
# 用「引入本修复的那个提交」作为旧版基线，而不是 HEAD —— 否则修复提交之后，
# HEAD:app/deploy/server-deploy.sh 与当前工作文件同为修复版，回退验证会失去意义。
# 找法：本文件所在目录中，最近一次修改 server-deploy.sh 的提交的前一个版本。
OLD_REF="$(git -C "$REPO_ROOT" log --format=%H -1 -- app/deploy/server-deploy.sh 2>/dev/null)"
if [ -z "$OLD_REF" ]; then
  bad "无法定位 server-deploy.sh 的历史提交（跳过回退验证）"
elif ! git -C "$REPO_ROOT" show "${OLD_REF}^:app/deploy/server-deploy.sh" > "$OLD" 2>/dev/null; then
  # 该脚本可能自诞生起就没改过 → 没有「修复前」版本可比，属正常情况
  echo "  （server-deploy.sh 只有一次提交记录，无修复前版本可比，跳过回退验证）"
  : > "$OLD"
fi
if [ -s "$OLD" ]; then
  # 说明：旧版还有个 macOS bash 3.2 才会触发的解析缺陷（`$rc）`/`$PORT，` 这类
  # 「变量名后紧跟全角标点」会把标点的首字节吃进变量名，触发 unbound variable）。
  # 那是另一个 bug，会掩盖本测试要验证的探针缺陷；所以给旧版打最小 ${} 兼容补丁，
  # 让它能跑到判据那一行，从而隔离出「假阳性」这个待验证行为。
  # 补丁只给变量加花括号，不动判据逻辑（`|| echo 000`、`= "000"`、无 updater 复查都原样保留）。
  perl -CSD -Mutf8 -i -pe 's/\$([a-zA-Z_][a-zA-Z0-9_]*)([^\x00-\x7F])/\${$1}$2/g' "$OLD"

  echo ""
  echo "▶ 缺陷②：站点可用但 updater 缺失（旧版应误报「部署成功」）"
  make_sandbox
  echo 401 > "$SB/state/curl-code"
  : > "$SB/state/updater-absent"
  run_script "$OLD"
  show 6; echo "    -> exit=$LAST_RC"
  if [ "$LAST_RC" -eq 0 ] && grep -q "===== 部署成功 =====" <<<"$LAST_OUT"; then
    ok "旧版确实报「部署成功」（exit 0）→ 用例 4 的断言有牙"
  else
    bad "旧版未复现（exit ${LAST_RC}）——用例 4 的回归验证不成立"
  fi

  echo ""
  echo "▶ 缺陷①：连接全断 + 构建失败（旧版应误报且打出 000000）"
  make_sandbox
  echo 2 > "$SB/state/up-fail-until"
  # 不写 curl-code → 探针恒失败
  run_script "$OLD"
  show 8; echo "    -> exit=$LAST_RC"
  if [ "$LAST_RC" -eq 0 ] && grep -q "000000" <<<"$LAST_OUT"; then
    ok "旧版在连接全断时报成功且打出 000000 → 用例 3 的断言有牙"
  else
    echo "    （旧版 exit=${LAST_RC}；000000 出现次数: $(grep -c '000000' <<<"$LAST_OUT" || true)）"
    bad "旧版未复现 000000 假阳性——用例 3 的回归验证不成立"
  fi
fi

# =====================================================================
echo ""
echo "========================================"
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "========================================"
[ "$FAIL" -eq 0 ] || exit 1
echo "全部通过 ✅"
exit 0
