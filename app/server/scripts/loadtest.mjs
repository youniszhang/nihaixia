#!/usr/bin/env node
// 负载压测：模拟 N 个并发虚拟用户走「登录 → 建会话 → 发消息（SSE 流式收完）→ 思考间隔」真实链路。
//
// 用法：
//   node scripts/loadtest.mjs --url http://127.0.0.1:18096 --users 500 --ramp 20 --think 1000
//   node scripts/loadtest.mjs --url ... --users 100 --duration 60      # 跑 60 秒
//
// 指标：成功/失败数、TTFB（首包）与总耗时 p50/p95/p99、吞吐（完成数/分钟）、客户端错误分布。
// 服务端水位另看 /health（rss/elag）与 mock 上游 /stats。
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  // 注意：初始值是数组，必须 push [key, value] 二元组再交给 Object.fromEntries；
  // 直接 acc[key]=v 只是在数组上挂命名属性，fromEntries 会全部丢弃（flag 静默失效）
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const BASE = args.url || 'http://127.0.0.1:18096';
const USERS = Number(args.users || 100);
const RAMP_S = Number(args.ramp ?? 10);          // 起压时间（秒）：在窗口内均匀拉起虚拟用户
const DURATION_S = Number(args.duration || 45);  // 压测时长（秒，起压完成后计时）
const THINK_MS = Number(args.think ?? 800);      // 每轮之间的思考间隔
const PWD = args.password || 'loadtest-123';
// 每个虚拟用户伪造独立 XFF（需服务端 TRUST_PROXY=1 才生效）：
// 目的一是绕开「同 IP 登录限流」对压测的干扰，二是模拟真实公网 IP 分布
const XFF_PREFIX = args['xff-prefix'] || '';

const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
};

let success = 0, failed = 0, active = 0, maxActive = 0;
const ttfbs = [], totals = [];
const errors = new Map();
const stopAt = Date.now() + (RAMP_S + DURATION_S) * 1000;
let stopped = false;
setTimeout(() => { stopped = true; console.log('  [停止信号] 等待在途请求收尾…'); }, (RAMP_S + DURATION_S) * 1000);

function recordError(code) { errors.set(code, (errors.get(code) || 0) + 1); }

const backoff = () => new Promise((r) => setTimeout(r, 1500 + Math.random() * 2500));

async function vuser(idx) {
  // 错峰起压
  const delay = Math.round((RAMP_S * 1000 * idx) / USERS);
  await new Promise((r) => setTimeout(r, delay));
  let cookie = '';
  const req = async (path, { method = 'GET', body, timeoutMs = 60000 } = {}) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(BASE + path, {
        method, signal: ac.signal,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...(XFF_PREFIX ? { 'X-Forwarded-For': `${XFF_PREFIX}.${Math.floor(idx / 200) % 250}.${10 + (idx % 200)}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return res;
    } finally { clearTimeout(t); }
  };

  // 登录（失败重试 2 次）
  for (let i = 0; i < 3 && !cookie; i++) {
    try {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: `load${idx}`, password: PWD }, timeoutMs: 15000 });
      if (!r.ok) { await req('/api/auth/register', { method: 'POST', body: { username: `load${idx}`, password: PWD }, timeoutMs: 15000 }).then(async (r2) => { if (r2.ok) { cookie = (r2.headers.get('set-cookie') || '').split(';')[0]; } }); }
    } catch (e) { recordError('login:' + (e.cause?.code || e.message)); await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!cookie) { failed += 1; recordError('login_failed'); return; }

  let round = 0;
  while (!stopped) {
    round += 1;
    active += 1; maxActive = Math.max(maxActive, active);
    const t0 = Date.now();
    let ttfb = 0;
    try {
      const sj = await (await req('/api/sessions', { method: 'POST', body: { module: 'tcm', title: `压测#${round}` } })).json();
      if (!sj?.session?.id) { failed += 1; recordError('session_create_failed'); await backoff(); continue; }
      const res = await req('/api/chat/send', { method: 'POST', body: { session_id: sj.session.id, content: `压测消息 #${round}` }, timeoutMs: 90000 });
      if (!res.ok) { failed += 1; recordError('send_' + res.status); await backoff(); continue; }
      // 流式消费到 done；服务端 SSE 的 error 事件计入错误分布
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let first = true, buf = '', sawError = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (first) { ttfb = Date.now() - t0; first = false; }
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5));
            if (ev.type === 'error') sawError = ev.message?.slice(0, 40) || 'error';
          } catch {}
        }
      }
      if (first) { failed += 1; recordError('empty_stream'); await backoff(); continue; }
      if (sawError) { failed += 1; recordError('sse:' + sawError); await backoff(); continue; }
      success += 1;
      ttfbs.push(ttfb);
      totals.push(Date.now() - t0);
    } catch (e) {
      failed += 1;
      recordError(e.name === 'AbortError' ? 'client_timeout' : (e.cause?.code || e.message).slice(0, 24));
      await backoff();
    } finally {
      active -= 1;
    }
    const wait = THINK_MS + Math.random() * THINK_MS;
    await new Promise((r) => setTimeout(r, wait));
  }
}

// ---- 概览打印（每 5 秒）----
const meter = setInterval(() => {
  const el = ((DURATION_S * 1000 - (stopAt - Date.now())) / 1000).toFixed(0);
  console.log(`  [${el}s] 活跃 ${active}（峰值 ${maxActive}）成功 ${success} 失败 ${failed}`);
}, 5000);

console.log(`压测目标 ${BASE}｜虚拟用户 ${USERS}｜起压 ${RAMP_S}s｜时长 ${DURATION_S}s｜思考 ~${THINK_MS}ms`);
console.log(`先确保账号已就位：node scripts/loadtest-setup.mjs --url ${BASE} --count ${USERS}`);
const vusers = Array.from({ length: USERS }, (_, i) => vuser(i));
await Promise.all(vusers);
clearInterval(meter);

console.log('\n========== 压测报告 ==========');
console.log(`虚拟用户   : ${USERS}`);
console.log(`成功/失败  : ${success} / ${failed}`);
console.log(`吞吐       : ${Math.round((success / DURATION_S) * 60)} 次/分钟`);
if (ttfbs.length) {
  console.log(`首包 TTFB  : p50=${percentile(ttfbs, 50)}ms  p95=${percentile(ttfbs, 95)}ms  p99=${percentile(ttfbs, 99)}ms`);
  console.log(`完整耗时   : p50=${percentile(totals, 50)}ms  p95=${percentile(totals, 95)}ms  p99=${percentile(totals, 99)}ms`);
}
if (errors.size) {
  console.log('错误分布   :');
  for (const [k, v] of [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${k} × ${v}`);
}
console.log(`服务端水位 : curl ${BASE}/health`);
process.exit(failed > success ? 1 : 0);
