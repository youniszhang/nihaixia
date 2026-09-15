import { getSetting, setSetting, deleteSetting, isAdminUser } from '../db.js';
import { sendError, clamp } from '../lib/validate.js';
import { openLoginWindow, checkLoginStatus, killBrowser, injectToken } from '../lib/dsweb.js';
import { verifyToken } from '../lib/dsapi.js';
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
      dsweb_has_token: Boolean(getSetting('dsweb_user_token') || process.env.DSWEB_USER_TOKEN),
      system_mode: getSetting('llm_system_mode') || 'auto',
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
    if (b.system_mode != null && ['auto', 'system', 'inline'].includes(b.system_mode)) {
      setSetting('llm_system_mode', b.system_mode);
    }
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
      dsweb_has_token: Boolean(getSetting('dsweb_user_token') || process.env.DSWEB_USER_TOKEN),
      system_mode: getSetting('llm_system_mode') || 'auto',
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
    // 配了登录凭证 → 直连校验（秒回，服务器上也可用）；否则回退到浏览器检测
    const saved = getSetting('dsweb_user_token') || process.env.DSWEB_USER_TOKEN;
    if (saved) {
      const v = await verifyToken(saved);
      return { loggedIn: v.ok, mode: 'direct', email: v.email || '', reason: v.ok ? '' : (v.reason || '') };
    }
    const port = Number(getSetting('dsweb_port') || 9223);
    try {
      const res = await checkLoginStatus(port);
      return { ...res, mode: 'browser' };
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

  // 保存登录凭证（userToken）：直连校验通过后写入设置；桌面版顺带注入专用浏览器
  fastify.post('/dsweb/inject-token', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const raw = clamp((req.body?.token || '').trim(), 4000);
    if (!raw) return sendError(reply, 'bad_request', '缺少 token');
    // 兼容从 localStorage 直接复制出的 {"value":"..."} 包装
    let token = raw;
    if (token.startsWith('{')) {
      try { token = String(JSON.parse(token).value || ''); } catch {}
    }
    if (!token) return sendError(reply, 'bad_token', 'token 为空');

    // 1) 直连校验（不依赖浏览器，服务器上也能用）
    const v = await verifyToken(token);
    if (!v.ok) return sendError(reply, 'invalid_token', `凭证无效或已过期：${v.reason || ''}`, 400);
    setSetting('dsweb_user_token', token);

    // 2) 桌面版：顺带把凭证注入专用浏览器（保留浏览器通道兼容）；失败不影响直连
    let browserSynced = false;
    try {
      const port = Number(getSetting('dsweb_port') || 9223);
      const res = await injectToken(port, token);
      browserSynced = Boolean(res?.loggedIn);
    } catch { /* 服务器无浏览器时忽略 */ }

    return { loggedIn: true, mode: 'direct', email: v.email || '', browserSynced };
  });

  // 清除登录凭证（回到浏览器通道）
  fastify.post('/dsweb/clear-token', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    deleteSetting('dsweb_user_token');
    return { ok: true };
  });
}
