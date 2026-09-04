import { getSetting, setSetting, isAdminUser } from '../db.js';
import { sendError, clamp } from '../lib/validate.js';

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
      base_url: getSetting('llm_base_url') || '',
      model: getSetting('llm_model') || '',
      has_key: Boolean(key),
      api_key_masked: maskKey(key),
    };
  });

  fastify.put('/llm', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const b = req.body || {};
    if (b.base_url != null) setSetting('llm_base_url', clamp(b.base_url.trim(), 300));
    if (b.model != null) setSetting('llm_model', clamp(b.model.trim(), 100));
    // Empty api_key = keep the existing one (frontend sends empty unless changed)
    if (typeof b.api_key === 'string' && b.api_key.trim()) {
      setSetting('llm_api_key', b.api_key.trim());
    }
    const key = getSetting('llm_api_key') || '';
    return {
      ok: true,
      base_url: getSetting('llm_base_url') || '',
      model: getSetting('llm_model') || '',
      has_key: Boolean(key),
      api_key_masked: maskKey(key),
    };
  });
}
