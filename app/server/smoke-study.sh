#!/usr/bin/env bash
# 冒烟测试：学习中心（study）全链路
#
# 覆盖：
#   1. 模块权限闸：未登录 401；未开通模块 403
#   2. 生成章节：SSE 流式 → 章节入库（HTML 白名单净化：<script> 被剥）
#   3. 章节列表 / 详情 / 删除
#   4. 出题：mock 返回题目 JSON → 题目下发不带答案
#   5. 判题：全对 / 全错两套提交，服务端判题结果正确
#   6. 错题集联动：答错入集 → 连对 2 次移出 → 再答错重新入集
#   7. 额度：生成扣 1 次（从 5 → 4）
#   8. 学习统计：章节数 / 已答题 / 正确率 / 在集错题
#
# 用法：bash smoke-study.sh
set -uo pipefail
cd "$(dirname "$0")"

TMP=/tmp/xs-study-smoke
rm -rf "$TMP"; mkdir -p "$TMP"
export APP_SECRET=study-smoke-secret
export DB_PATH="$TMP/nihaixia.db"
export PORT=18097
export HOST=127.0.0.1
export LOG_LEVEL=silent
export ADMIN_USERNAME=admin
export ALLOW_NO_LLM=true
unset TRUST_PROXY CORS_ORIGIN

# —— mock LLM：按请求内容区分「章节 HTML」与「题目 JSON」 ——
# 章节请求带「学习章节」；出题请求带「命题人」。
node > "$TMP/mock.log" 2>&1 << 'MOCKEOF' &
import http from 'node:http';

const CHAPTER_HTML = [
  '<h2>六经辨证入门</h2>',
  '<script>alert("evil")</script>',
  '<p>六经辨证是《伤寒论》的核心框架。太阳主表，阳明主里热。</p>',
  '<h3>太阳病</h3>',
  '<table><thead><tr><th>主证</th><th>主方</th></tr></thead>',
  '<tbody><tr><td>恶寒无汗脉浮紧</td><td>麻黄汤</td></tr>',
  '<tr><td>汗出恶风脉浮缓</td><td>桂枝汤</td></tr></tbody></table>',
  '<h3>本章要点</h3>',
  '<ul><li>先辨六经再选方</li><li>保胃气存津液</li></ul>',
].join('\n');

const QUIZ_JSON = JSON.stringify([
  { type: 'single', stem: '太阳病伤寒表实证的代表方是？', options: ['桂枝汤', '麻黄汤', '小柴胡汤', '白虎汤'], answer: 'B', explanation: '恶寒无汗脉浮紧为表实，用麻黄汤发汗解表。' },
  { type: 'single', stem: '桂枝汤的主证是？', options: ['无汗', '汗出恶风', '但热不寒', '呕吐下利'], answer: 'B', explanation: '汗出恶风脉浮缓为表虚，用桂枝汤调和营卫。' },
  { type: 'multi', stem: '六经辨证包含哪些经？', options: ['太阳', '阳明', '少阳', '太阴', '少阴'], answer: 'A,B,C,D,E', explanation: '六经为太阳阳明少阳太阴少阴厥阴，此处五项皆列。' },
  { type: 'tf', stem: '阳明病属里热证。', options: ['对', '错'], answer: '对', explanation: '阳明为里热实证，主清下。' },
  { type: 'tf', stem: '少阴病属三阳证。', options: ['对', '错'], answer: '错', explanation: '少阴属三阴，心肾虚衰。' },
]);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const isQuiz = body.includes('命题人');
    const text = isQuiz ? QUIZ_JSON : CHAPTER_HTML;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // 分 3 块流出（验证流式聚合）
    const chunks = [text.slice(0, Math.ceil(text.length / 3)), text.slice(Math.ceil(text.length / 3), Math.ceil(2 * text.length / 3)), text.slice(Math.ceil(2 * text.length / 3))];
    let i = 0;
    const send = () => {
      if (i >= chunks.length) {
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`);
      i += 1;
      setTimeout(send, 15);
    };
    setTimeout(send, 30);
  });
});
server.listen(18093, () => console.log('study mock upstream on :18093'));
MOCKEOF
MOCK=$!
trap 'kill $MOCK $SRV 2>/dev/null' EXIT

node src/index.js > "$TMP/server.log" 2>&1 &
SRV=$!

H=http://127.0.0.1:18097
B=$H/api
code=""
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$H/health" || true)
  [ "$code" = "200" ] && break; sleep 0.5
done
if [ "${code:-}" != "200" ]; then echo "!! 服务未起来"; tail -20 "$TMP/server.log"; exit 1; fi

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; pass=$((pass+1));
        else echo "  FAIL $1 expected=$2 actual=$3"; fail=$((fail+1)); fi; }
jq_get() { python3 -c "
import json,sys
d=json.load(sys.stdin)
try: print(d$1)
except Exception: print('')"; }
sse_collect() { # 把 SSE 流聚成 JSON 事件列表
  python3 -c "
import json,sys
events=[]
for line in sys.stdin:
    line=line.strip()
    if not line.startswith('data:'): continue
    try: events.append(json.loads(line[5:]))
    except Exception: pass
print(json.dumps(events))"
}

echo "== 1. 权限闸 =="
chk "未登录 GET /study/tcm" "401" "$(curl -s -o /dev/null -w '%{http_code}' $B/study/tcm)"
# bootstrap 建管理员 + 普通用户（走邀请码）
curl -s -c "$TMP/admin.jar" -X POST $B/auth/register -H 'content-type: application/json' -d '{"username":"admin","password":"secret123"}' -o /dev/null
INV=$(curl -s -b "$TMP/admin.jar" -X POST $B/admin/invites -H 'content-type: application/json' -d '{"max_uses":1,"note":"study-smoke"}')
CODE=$(echo "$INV" | grep -o '"code":"[A-Z0-9]*"' | head -1 | cut -d'"' -f4)
curl -s -c "$TMP/u.jar" -X POST $B/auth/register -H 'content-type: application/json' -d "{\"username\":\"student\",\"password\":\"secret123\",\"invite_code\":\"$CODE\"}" -o /dev/null
# 塔罗模块默认未上线 → 学习中心也 403
chk "未开通模块 study 403" "403" "$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' $B/study/tarot)"
chk "中医模块 study 200" "200" "$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' $B/study/tcm)"

echo
echo "== 2. 配置 mock LLM 通道 + 额度 =="
curl -s -b "$TMP/admin.jar" -X PUT $B/admin/llm -H 'content-type: application/json' \
  -d '{"provider":"api","base_url":"http://127.0.0.1:18093","model":"mock","api_key":"sk-mock","system_mode":"inline"}' > /dev/null
# 给学生账号设 5 次额度，验证扣费
AID=$(curl -s -b "$TMP/admin.jar" $B/admin/users | jq_get "['users'][1]['id']")
curl -s -b "$TMP/admin.jar" -X PATCH $B/admin/users/$AID -H 'content-type: application/json' -d '{"credits":5}' > /dev/null

echo
echo "== 3. 生成章节（SSE）=="
GEN=$(curl -s -N -b "$TMP/u.jar" -X POST $B/study/tcm/generate -H 'content-type: application/json' -d '{"topic":"六经辨证入门"}' | sse_collect)
echo "$GEN" | python3 -c "
import json,sys
evs=json.load(sys.stdin)
types=[e.get('type') for e in evs]
done=[e for e in evs if e.get('type')=='done']
deltas=''.join(e.get('text','') for e in evs if e.get('type')=='delta')
assert 'start' in types, 'missing start'
assert 'done' in types, 'missing done'
assert '六经辨证' in deltas, 'delta content empty'
ch=done[0]['chapter'] if done else {}
assert ch.get('title')=='六经辨证入门', f\"title={ch.get('title')}\"
# 净化验证：<script> 必须被剥掉
assert '<script' not in (ch.get('content_html') or ''), 'script survived sanitize!'
assert '麻黄汤' in (ch.get('content_html') or ''), 'table content lost'
assert '<table>' in (ch.get('content_html') or ''), 'table tag lost'
print('ok   SSE 生成 + 净化 + 入库 (chapter id=%s)' % ch.get('id'))
open('$TMP/chid','w').write(str(ch.get('id') or 0))
" && pass=$((pass+1)) || { echo "  FAIL 生成链路"; fail=$((fail+1)); echo "$GEN" | head -c 600; }
CHID=$(cat "$TMP/chid" 2>/dev/null || echo 0)

echo
echo "== 4. 额度扣减 =="
# 单用户端点不存在：从用户列表里找 student 的额度
CR=$(curl -s -b "$TMP/admin.jar" $B/admin/users | python3 -c "
import json,sys
for u in json.load(sys.stdin)['users']:
    if u['username']=='student': print(u.get('credits')); break")
chk "生成后额度 5→4" "4" "$CR"

echo
echo "== 5. 章节列表 / 详情 / 删除（另一用户共享） =="
LIST=$(curl -s -b "$TMP/u.jar" $B/study/tcm)
chk "列表含新章节" "六经辨证入门" "$(echo "$LIST" | jq_get "['chapters'][0]['title']")"
# 新行为：首次访问自动铺内置目录（tcm 25 章占位）+ 用户刚生成的一章
chk "统计章节数≥26（含铺的目录）" "yes" "$(echo "$LIST" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('yes' if d['stats']['chapters'] >= 26 else 'no')")"
chk "内置目录已铺占位" "yes" "$(echo "$LIST" | python3 -c "
import json,sys
d=json.load(sys.stdin)
phs=[c for c in d['chapters'] if c.get('is_placeholder')]
print('yes' if len(phs) >= 25 else 'no')")"
DET=$(curl -s -b "$TMP/u.jar" $B/study/chapter/$CHID)
chk "详情含正文" "yes" "$(echo "$DET" | grep -q '麻黄汤' && echo yes || echo no)"
chk "管理员也能读" "200" "$(curl -s -b "$TMP/admin.jar" -o /dev/null -w '%{http_code}' $B/study/chapter/$CHID)"
# 生成者本人删除（用另一个新章节测：先再生成一章）
GEN2=$(curl -s -N -b "$TMP/u.jar" -X POST $B/study/tcm/generate -H 'content-type: application/json' -d '{"topic":"太阳病详解"}' | sse_collect)
CHID2=$(echo "$GEN2" | jq_get "[-1]['chapter']['id']")
chk "第二章节生成" "yes" "$([ -n "$CHID2" ] && [ "$CHID2" != "None" ] && echo yes || echo no)"

echo
echo "== 6. 出题（题目不带答案） =="
QZ=$(curl -s -b "$TMP/u.jar" -X POST $B/study/tcm/quiz -H 'content-type: application/json' -d "{\"chapter_id\":$CHID,\"count\":5}")
chk "返回 5 题" "5" "$(echo "$QZ" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('questions',[])))")"
chk "题目含真实 id" "yes" "$(echo "$QZ" | python3 -c "import json,sys; d=json.load(sys.stdin); qs=d.get('questions',[]); print('yes' if qs and all(q.get('id',0)>0 for q in qs) else 'no')")"
chk "题目不含答案" "no" "$(echo "$QZ" | grep -q '"answer"' && echo yes || echo no)"
chk "题目不含解析" "no" "$(echo "$QZ" | grep -q '"explanation"' && echo yes || echo no)"
chk "题型含多选" "yes" "$(echo "$QZ" | grep -q '"multi"' && echo yes || echo no)"
# 刷新重取（题库已落库，重取走 DB）
chk "重取题库 200" "200" "$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' $B/study/tcm/quiz/$CHID)"

echo
echo "== 7. 判题：先全错（答错入错题集） =="
# 答案：B B A,B,C,D,E 对 错 → 全错提交：全给错误答案
SUB1=$(curl -s -b "$TMP/u.jar" -X POST $B/study/tcm/submit -H 'content-type: application/json' -d "{\"chapter_id\":$CHID,\"answers\":[\"A\",\"A\",\"A\",\"错\",\"对\"]}")
chk "总分 0" "0" "$(echo "$SUB1" | jq_get "['correct']")"
chk "错题入集 5" "5" "$(curl -s -b "$TMP/u.jar" $B/study/tcm/wrongs | jq_get "['stats']['wrong_set']")"
chk "已答题 5" "5" "$(echo "$SUB1" | jq_get "['stats']['answered']")"

echo
echo "== 8. 判题：连对两次移出错题集 + 再答错重新入集 =="
# 错题重练：先对一次（streak=1，仍在集），再对一次（streak=2，移出）
WR1=$(curl -s -b "$TMP/u.jar" -X POST $B/study/tcm/wrongs/submit -H 'content-type: application/json' -d '{"answers":["B","B","A,B,C,D,E","对","错"]}')
chk "重练全对 5/5" "5" "$(echo "$WR1" | jq_get "['correct']")"
chk "对一次仍在集" "5" "$(curl -s -b "$TMP/u.jar" $B/study/tcm/wrongs | jq_get "['stats']['wrong_set']")"
WR2=$(curl -s -b "$TMP/u.jar" -X POST $B/study/tcm/wrongs/submit -H 'content-type: application/json' -d '{"answers":["B","B","A,B,C,D,E","对","错"]}')
chk "连对两次移出" "0" "$(curl -s -b "$TMP/u.jar" $B/study/tcm/wrongs | jq_get "['stats']['wrong_set']")"
chk "移出标记返回" "True" "$(echo "$WR2" | jq_get "['results'][0]['removed']")"
chk "历史错题可查" "5" "$(curl -s -b "$TMP/u.jar" "$B/study/tcm/wrongs?all=1" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('wrongs',[])))")"
# 移出后通过 quiz 链路再答错 → 重新入集（题目仍在库，attempts 覆盖更新）
SUB3=$(curl -s -b "$TMP/u.jar" -X POST $B/study/tcm/submit -H 'content-type: application/json' -d "{\"chapter_id\":$CHID,\"answers\":[\"A\",\"A\",\"A\",\"错\",\"对\"]}")
chk "再答错重新入集" "5" "$(echo "$SUB3" | jq_get "['stats']['wrong_set']")"

echo
echo "== 9. 章节答题链路（quiz 提交判对） =="
SUB2=$(curl -s -b "$TMP/u.jar" -X POST $B/study/tcm/submit -H 'content-type: application/json' -d "{\"chapter_id\":$CHID,\"answers\":[\"B\",\"B\",\"A,B,C,D,E\",\"对\",\"错\"]}")
chk "全对 5/5" "5" "$(echo "$SUB2" | jq_get "['correct']")"
chk "解析已下发" "yes" "$(echo "$SUB2" | grep -q '麻黄汤' && echo yes || echo no)"

echo
echo "== 10. 删除章节（错题快照保留） =="
chk "生成者删自己章节" "200" "$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' -X DELETE $B/study/chapter/$CHID2)"
# 章节数 = 25 内置目录 + 1（主章节 CHID 还在，稍后删）
chk "删除后剩 26（25 目录 + 主章）" "26" "$(curl -s -b "$TMP/u.jar" $B/study/tcm | jq_get "['stats']['chapters']")"
# 删主章节（含题库）→ 章节与题目一并失效
chk "章节删除" "200" "$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' -X DELETE $B/study/chapter/$CHID)"
chk "章节 404" "404" "$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' $B/study/chapter/$CHID)"
# 两步式：bash 单行 $() 内嵌套引号转义存在边缘 case，拆开最稳
SUBCODE=$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' -X POST $B/study/tcm/submit -H 'content-type: application/json' -d "{\"chapter_id\":$CHID,\"answers\":[\"A\",\"A\",\"A\",\"错\",\"对\"]}")
chk "题目随章节失效 404" "404" "$SUBCODE"
# 错题重练仍可（快照不依赖章节）
chk "错题重练仍可用" "200" "$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' -X POST $B/study/tcm/wrongs/submit -H 'content-type: application/json' -d '{"answers":["A","A","A","错","对"]}')"

echo
echo "== 11. 额度耗尽拦截 =="
curl -s -b "$TMP/admin.jar" -X PATCH $B/admin/users/$AID -H 'content-type: application/json' -d '{"credits":0}' > /dev/null
chk "额度 0 生成 402" "402" "$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' -X POST $B/study/tcm/generate -H 'content-type: application/json' -d '{"topic":"x"}')"
chk "额度 0 出题 402" "402" "$(curl -s -b "$TMP/u.jar" -o /dev/null -w '%{http_code}' -X POST $B/study/tcm/quiz -H 'content-type: application/json' -d '{"chapter_id":1}')"

echo
echo "=================================="
echo "PASS: $pass  FAIL: $fail"
[ "$fail" = "0" ] || { echo "!! 有失败项，服务日志："; tail -30 "$TMP/server.log"; exit 1; }
echo "全部通过"
