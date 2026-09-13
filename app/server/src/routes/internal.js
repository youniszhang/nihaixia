// 内部通道：仅限桌面端 Rust 启动器调用（x-internal-token 校验）。
// 用于应用内 DeepSeek 登录窗口的 token 回传注入。

import { getSetting } from '../db.js';
import { injectToken } from '../lib/dsweb.js';

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

// 应用内登录流程状态（单用户本地场景，内存态足够）
export const loginFlow = { state: 'idle', startedAt: 0, result: null };

export default async function internalRoutes(fastify) {
  fastify.addHook('onRequest', async (req, reply) => {
    if (!INTERNAL_TOKEN || req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
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
    const port = Number(getSetting('dsweb_port') || 9223);
    try {
      const res = await injectToken(port, token);
      loginFlow.state = res.loggedIn ? 'success' : 'failed';
      loginFlow.result = { loggedIn: res.loggedIn, hasEditor: res.hasEditor };
    } catch (err) {
      loginFlow.state = 'failed';
      loginFlow.result = { error: String(err).slice(0, 160) };
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
