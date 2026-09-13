import { getSetting, setSetting, isAdminUser } from '../db.js';
import { sendError, clamp } from '../lib/validate.js';
import { openLoginWindow, checkLoginStatus, killBrowser, injectToken } from '../lib/dsweb.js';
import { startInAppLoginFlow, inAppLoginStatus } from './internal.js';

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return key.slice(0, 2) + '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

export default async function adminRoutes(fastify) {
  const adminOnly = {
    preHandler: [fastify.authenticate],
    onRequest: async (req, reply) => {
      // preHandler runs after authenticate; guard again here for clarity
    },
  };

  fastify.get('/llm', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const key = getSetting('llm_api_key') || '';
    return {
      provider: getSetting('llm_provider') === 'dsweb' ? 'dsweb' : 'api',
      base_url: getSetting('llm_base_url') || '',
      model: getSetting('llm_model') || '',
      has_key: Boolean(key),
      api_key_masked: maskKey(key),
      dsweb_port: Number(getSetting('dsweb_port') || 9223),
      dsweb_expert: getSetting('dsweb_expert') !== 'false',
    };
  });

  fastify.put('/llm', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const b = req.body || {};
    if (b.provider === 'api' || b.provider === 'dsweb') setSetting('llm_provider', b.provider);
    if (b.base_url != null) setSetting('llm_base_url', clamp(b.base_url.trim(), 300));
    if (b.model != null) setSetting('llm_model', clamp(b.model.trim(), 100));
    // Empty api_key = keep the existing one (frontend sends empty unless changed)
    if (typeof b.api_key === 'string' && b.api_key.trim()) {
      setSetting('llm_api_key', b.api_key.trim());
    }
    if (b.dsweb_port != null && Number(b.dsweb_port) > 0) setSetting('dsweb_port', String(Number(b.dsweb_port)));
    if (b.dsweb_expert != null) setSetting('dsweb_expert', b.dsweb_expert ? 'true' : 'false');
    const key = getSetting('llm_api_key') || '';
    return {
      ok: true,
      provider: getSetting('llm_provider') === 'dsweb' ? 'dsweb' : 'api',
      base_url: getSetting('llm_base_url') || '',
      model: getSetting('llm_model') || '',
      has_key: Boolean(key),
      api_key_masked: maskKey(key),
      dsweb_port: Number(getSetting('dsweb_port') || 9223),
      dsweb_expert: getSetting('dsweb_expert') !== 'false',
    };
  });

  // —— 网页版 DeepSeek（0 Token）——
  fastify.post('/dsweb/open-login', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const port = Number(getSetting('dsweb_port') || 9223);
    try {
      return await openLoginWindow(port);
    } catch (err) {
      return sendError(reply, 'dsweb_open_failed', (err.message || String(err)).slice(0, 200));
    }
  });

  fastify.get('/dsweb/check-login', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const port = Number(getSetting('dsweb_port') || 9223);
    try {
      const res = await checkLoginStatus(port);
      return res;
    } catch (err) {
      return sendError(reply, 'dsweb_check_failed', (err.message || String(err)).slice(0, 200));
    }
  });

  fastify.post('/dsweb/kill-browser', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    killBrowser();
    return { ok: true };
  });

  // 应用内登录流程：前端发起 → Tauri 事件开窗 → Rust 轮询 token 走内部通道注入
  fastify.post('/dsweb/in-app-login-start', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    startInAppLoginFlow();
    return { ok: true };
  });

  fastify.get('/dsweb/in-app-login-status', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    return inAppLoginStatus();
  });

  // 应用内登录窗口获取到 userToken 后，写入专用浏览器并验证
  fastify.post('/dsweb/inject-token', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const token = clamp((req.body?.token || '').trim(), 4000);
    if (!token) return sendError(reply, 'bad_request', '缺少 token');
    // 兼容 {"value":"..."} 包装
    let t = token;
    if (t.startsWith('{')) {
      try { t = String(JSON.parse(t).value || ''); } catch {}
    }
    if (!t) return sendError(reply, 'bad_token', 'token 为空');
    const port = Number(getSetting('dsweb_port') || 9223);
    try {
      const res = await injectToken(port, t);
      return { loggedIn: res.loggedIn, hasEditor: res.hasEditor };
    } catch (err) {
      return sendError(reply, 'dsweb_inject_failed', (err.message || String(err)).slice(0, 200));
    }
  });
}
