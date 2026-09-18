// 内部通道：仅限桌面端 Rust 启动器调用（x-internal-token 校验）。
// 用于应用内 DeepSeek 登录窗口的 token 回传注入。

import { getSetting, setSetting } from '../db.js';
import { injectToken } from '../lib/dsweb.js';
import { verifyToken } from '../lib/dsapi.js';
import crypto from 'node:crypto';

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

// 常量时间比较（安全）：避免逐字符比较的时序侧信道
function tokenMatches(got) {
  if (!INTERNAL_TOKEN || typeof got !== 'string' || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(INTERNAL_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 来源仅限本机回环（安全）：桌面版 Rust 启动器经 127.0.0.1 调用；
// 而桌面版服务监听 0.0.0.0（为让手机 PWA 连入），不加这条则同一 Wi-Fi 下
// 任何设备都能调用 /internal/dsweb-inject 写入任意 DeepSeek 凭证。
function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// 应用内登录流程状态（单用户本地场景，内存态足够）
export const loginFlow = { state: 'idle', startedAt: 0, result: null };

export default async function internalRoutes(fastify) {
  fastify.addHook('onRequest', async (req, reply) => {
    if (!isLoopback(req) || !tokenMatches(req.headers['x-internal-token'])) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  });

  // Rust 轮询到登录 token 后调用：注入专用浏览器并验证
  fastify.post('/dsweb-inject', async (req, reply) => {
    let token = String(req.body?.token || '').trim();
    if (!token) {
      loginFlow.state = 'failed';
      return { ok: false, state: 'failed' };
    }
    if (token.startsWith('{')) {
      try { token = String(JSON.parse(token).value || ''); } catch {}
    }
    // 先直连校验（快，且服务器上也成立）：通过则保存凭证，供直连通道使用
    const v = await verifyToken(token);
    if (v.ok) setSetting('dsweb_user_token', token);
    // 桌面版：顺带注入专用浏览器（保留浏览器通道兼容）；无浏览器时忽略
    const port = Number(getSetting('dsweb_port') || 9223);
    try {
      const res = await injectToken(port, token);
      loginFlow.state = (v.ok || res.loggedIn) ? 'success' : 'failed';
      loginFlow.result = { loggedIn: v.ok || res.loggedIn, hasEditor: res.hasEditor, mode: v.ok ? 'direct' : 'browser' };
    } catch (err) {
      loginFlow.state = v.ok ? 'success' : 'failed';
      loginFlow.result = v.ok
        ? { loggedIn: true, mode: 'direct' }
        : { error: String(err).slice(0, 160) };
    }
    return { ok: true, state: loginFlow.state };
  });
}

export function startInAppLoginFlow() {
  loginFlow.state = 'waiting';
  loginFlow.startedAt = Date.now();
  loginFlow.result = null;
}

export function inAppLoginStatus() {
  // 4 分钟未完成 → 超时
  if (loginFlow.state === 'waiting' && Date.now() - loginFlow.startedAt > 240000) {
    loginFlow.state = 'timeout';
  }
  return {
    state: loginFlow.state,
    result: loginFlow.result,
  };
}
