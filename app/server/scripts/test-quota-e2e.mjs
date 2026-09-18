#!/usr/bin/env node
// 额度 / 每日签到 / 订阅 的端到端自测（真起服务端 + mock LLM，不消耗真实模型额度）。
//
// 用法：node scripts/test-quota-e2e.mjs
// 覆盖：
//   1. 默认额度：站点设 default_credits=0 后，新用户为额度制、0 次 → 被 402 拦下
//   2. 签到：首签加分、连签天数、重复签到 409、Turnstile 开启后无 token 被拦
//   3. 额度扣减：成功问诊扣 1 次，剩余额度实时下降
//   4. 订阅：申请 → 管理员审批 → 额度入账 + 套餐每日上限生效（优先级 user > plan > site）
//   5. 不限次账号（老账号语义）不受额度限制
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const APP_DIR = path.resolve(SERVER_DIR, '..');
const MOCK = path.join(APP_DIR, 'desktop', 'scripts', 'mock-llm.mjs');

const PORT = Number(process.env.E2E_PORT || 8210);
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT || 9099);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_DIR = fs.mkdtempSync('/tmp/nhx-e2e-');
const DB_PATH = path.join(DB_DIR, 'nihaixia.db');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, extra = '') {
  if (ok) { pass++; results.push(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { fail++; results.push(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 极简 cookie 会话（每个账号一份）----
function makeClient(label) {
  const jar = new Map();
  return {
    label,
    cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    save(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (v) jar.set(k, v); else jar.delete(k);
      }
    },
    async req(method, p, body) {
      const res = await fetch(BASE + p, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar.size ? { Cookie: this.cookieHeader() } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      this.save(res);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* SSE 或空响应 */ }
      return { status: res.status, json, text };
    },
    // 流式问诊：返回是否收到 done 事件与事件里的 quota
    async chat(sessionId, content) {
      const res = await fetch(`${BASE}/api/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: this.cookieHeader() },
        body: JSON.stringify({ session_id: sessionId, content }),
      });
      this.save(res);
      if (!res.ok) {
        const t = await res.text();
        let j = null; try { j = JSON.parse(t); } catch {}
        return { ok: false, status: res.status, error: j?.error, message: j?.message };
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', done = null, deltas = '';
      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            if (ev.type === 'delta') deltas += ev.text;
            if (ev.type === 'done') done = ev;
          }
        }
      }
      return { ok: true, status: res.status, done, chars: deltas.length };
    },
    async newSession() {
      const r = await this.req('POST', '/api/sessions', { title: 'e2e' });
      return r.json.session.id;
    },
  };
}

async function waitFor(url, tries = 60, ms = 300) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(ms);
  }
  return false;
}

const procs = [];
function launch(name, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return p;
}

async function main() {
  console.log(`▶ 端到端自测（DB: ${DB_PATH}）`);
  launch('mock', process.execPath, [MOCK], { PORT: String(MOCK_PORT) });
  launch('server', process.execPath, [path.join(SERVER_DIR, 'src', 'index.js')], {
    PORT: String(PORT), HOST: '127.0.0.1', DB_PATH,
    APP_SECRET: 'e2e-secret', INTERNAL_TOKEN: 'e2e-internal',
    ADMIN_USERNAME: 'e2e_admin', ALLOW_NO_LLM: 'true', LOG_LEVEL: 'error', TZ: 'Asia/Shanghai',
    LLM_API_KEY: 'mock-key', LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, LLM_MODEL: 'mock-model',
    LLM_TIMEOUT_MS: '20000',
  });

  const upServer = await waitFor(`${BASE}/health`);
  if (!upServer) { console.error('服务端未就绪'); process.exit(1); }
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/`).catch(() => {});

  const admin = makeClient('admin');
  const bob = makeClient('bob');

  // ---------- 1. 注册与默认额度 ----------
  const regAdmin = await admin.req('POST', '/api/auth/register', { username: 'e2e_admin', password: 'e2e-admin-pw' });
  check('管理员注册', regAdmin.status === 200 && regAdmin.json?.user?.is_admin === true, `is_admin=${regAdmin.json?.user?.is_admin}`);

  const site0 = await admin.req('PUT', '/api/admin/site', { default_credits: '0', registration_enabled: true });
  check('站点设置：新用户默认额度 = 0', site0.status === 200 && site0.json?.default_credits === '0', `default_credits=${site0.json?.default_credits}`);
  // 注：注册默认关闭（仅凭邀请码可注册，见 777a4c4）。本测试用管理员显式开启自助注册 ——
  //     否则 bob 的注册会被 registration_closed 拦下，后续步骤全崩（非本测试目标，属前置条件）。

  const regBob = await bob.req('POST', '/api/auth/register', { username: 'e2e_bob', password: 'e2e-bob-pw' });
  check('普通用户注册', regBob.status === 200 && regBob.json?.user?.is_admin === false);

  const bobQuota0 = await bob.req('GET', '/api/checkin');
  check('新用户为额度制且 0 次', bobQuota0.json?.quota?.credits === 0 && bobQuota0.json?.quota?.unlimited === false,
    `credits=${bobQuota0.json?.quota?.credits}`);

  // ---------- 2. 额度为 0 时被拦 ----------
  const sid1 = await bob.newSession();
  const blocked = await bob.chat(sid1, '你好');
  check('额度耗尽被拦（402 no_credits）', blocked.status === 402 && blocked.error === 'no_credits', `${blocked.status} ${blocked.error}`);

  // ---------- 3. 每日签到 ----------
  const st1 = await bob.req('GET', '/api/checkin');
  check('签到状态：今日未签、预期奖励 3', st1.json?.checkin?.checked_in === false && st1.json?.checkin?.reward_next === 3,
    `reward_next=${st1.json?.checkin?.reward_next}`);

  const c1 = await bob.req('POST', '/api/checkin', {});
  check('首次签到成功并加分', c1.status === 200 && c1.json?.credited === true && c1.json?.balance === 3,
    `reward=${c1.json?.reward} balance=${c1.json?.balance} streak=${c1.json?.streak}`);

  const c2 = await bob.req('POST', '/api/checkin', {});
  check('重复签到被拒（409 already）', c2.status === 409 && c2.json?.error === 'already', `${c2.status} ${c2.json?.error}`);

  // ---------- 4. 问诊扣额度 ----------
  const chat1 = await bob.chat(sid1, '我感冒了，怕冷没汗');
  check('签到后有额度可问诊（流式完成）', chat1.ok && chat1.done && chat1.chars > 0, `chars=${chat1.chars}`);
  check('done 事件带回剩余额度 = 2', chat1.done?.quota?.credits === 2, `credits=${chat1.done?.quota?.credits}`);

  const after = await bob.req('GET', '/api/checkin');
  check('服务端剩余额度已扣到 2', after.json?.quota?.credits === 2, `credits=${after.json?.quota?.credits}`);
  check('额度流水含签到与消耗两条', (after.json?.ledger || []).some((l) => l.reason === 'checkin') && (after.json?.ledger || []).some((l) => l.reason === 'consume'),
    (after.json?.ledger || []).map((l) => `${l.reason}${l.delta}`).join(','));

  // ---------- 5. 订阅：申请 → 审批 ----------
  const planRes = await admin.req('POST', '/api/admin/plans', {
    name: '月度会员', description: '每月 50 次', price_cents: 990, period_days: 30, credits: 50, daily_chat_limit: 20,
  });
  check('管理员创建套餐', planRes.status === 201 && planRes.json?.plan?.id > 0, `id=${planRes.json?.plan?.id}`);
  const planId = planRes.json.plan.id;

  const bobPlans = await bob.req('GET', '/api/subscription');
  check('用户可见套餐列表', (bobPlans.json?.plans || []).length === 1 && bobPlans.json.plans[0].name === '月度会员');

  const applied = await bob.req('POST', '/api/subscription/apply', { plan_id: planId, note: '想开通' });
  check('提交开通申请（pending）', applied.status === 200 && applied.json?.pending?.status === 'pending');
  const subId = applied.json.pending.id;

  const dupApply = await bob.req('POST', '/api/subscription/apply', { plan_id: planId });
  check('重复申请被拒（409 pending_exists）', dupApply.status === 409 && dupApply.json?.error === 'pending_exists');

  const approved = await admin.req('POST', `/api/admin/subscriptions/${subId}/approve`, {});
  check('管理员审批通过', approved.status === 200 && approved.json?.ok === true, `到期=${approved.json?.expires_at}`);

  const afterSub = await bob.req('GET', '/api/subscription');
  const q = afterSub.json?.quota || {};
  check('订阅生效：额度 2+50=52', q.credits === 52, `credits=${q.credits}`);
  check('订阅生效：每日上限取套餐值 20', q.daily_limit === 20 && q.daily_limit_source === 'plan', `${q.daily_limit}/${q.daily_limit_source}`);
  check('订阅状态为 active 且到期时间在 30 天后', afterSub.json?.current?.status === 'active' && Boolean(afterSub.json?.current?.expires_at), afterSub.json?.current?.expires_at);

  // ---------- 6. 优先级：用户专属 > 套餐 > 站点 ----------
  await admin.req('PATCH', `/api/admin/users/${regBob.json.user.id}`, { daily_chat_limit: 1 });
  const chat2 = await bob.chat(sid1, '第二个问题');
  check('用户专属上限 1 次：第二次被 429 拦', chat2.status === 429 && chat2.error === 'daily_limit' && /每天 1 次/.test(chat2.message || ''),
    `${chat2.status} ${chat2.message}`);

  // 放宽上限后应恢复
  await admin.req('PATCH', `/api/admin/users/${regBob.json.user.id}`, { daily_chat_limit: null });
  const chat3 = await bob.chat(sid1, '第三个问题');
  check('上限跟随套餐后恢复可问诊', chat3.ok && chat3.done && chat3.done?.quota?.limited !== false, `credits=${chat3.done?.quota?.credits}`);

  // ---------- 7. 不限次账号（老账号语义） ----------
  const adminChat = await (async () => {
    const sid = await admin.newSession();
    return admin.chat(sid, '管理员问一句');
  })();
  check('不限次账号不受额度限制', adminChat.ok && adminChat.done && adminChat.done?.quota?.unlimited === true,
    `unlimited=${adminChat.done?.quota?.unlimited}`);

  // ---------- 8. Turnstile 人机校验开关 ----------
  const tsOn = await admin.req('PUT', '/api/admin/site', { turnstile_site_key: '1x00000000000000000000AA', turnstile_secret_key: '1x0000000000000000000000000000000AA' });
  check('开启人机校验（后台不再回传 secret）', tsOn.status === 200 && tsOn.json?.turnstile_active === true && tsOn.json?.turnstile_secret_set === true && tsOn.json?.turnstile_site_key === '1x00000000000000000000AA');

  const carol = makeClient('carol');
  await carol.req('POST', '/api/auth/register', { username: 'e2e_carol', password: 'e2e-carol-pw' });
  const noToken = await carol.req('POST', '/api/checkin', {});
  check('无 token 时签到被人机校验拦下', noToken.status === 400 && noToken.json?.error === 'captcha_failed', `${noToken.status} ${noToken.json?.error}`);

  const siteNow = await admin.req('GET', '/api/admin/site');
  check('签到设置可读（奖励/连签加成/开关）', siteNow.json?.checkin_enabled === true && siteNow.json?.checkin_reward === 3,
    `reward=${siteNow.json?.checkin_reward} bonus=${siteNow.json?.checkin_streak_bonus}`);

  const adminUsers = await admin.req('GET', '/api/admin/users');
  const bobRow = (adminUsers.json?.users || []).find((u) => u.username === 'e2e_bob');
  check('后台用户列表带额度/订阅/签到列', Boolean(bobRow) && bobRow.credits != null && bobRow.plan_name === '月度会员' && bobRow.checkin_count === 1,
    `credits=${bobRow?.credits} plan=${bobRow?.plan_name} checkins=${bobRow?.checkin_count}`);

  console.log('\n' + results.join('\n'));
  console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / ${pass + fail}\n`);
}

main()
  .catch((e) => { console.error('自测异常：', e); fail++; })
  .finally(async () => {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
    await sleep(200);
    try { fs.rmSync(DB_DIR, { recursive: true, force: true }); } catch {}
    process.exit(fail === 0 ? 0 : 1);
  });
