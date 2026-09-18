import {
  createSession, listSessions, getSession, renameSession, updateSessionPin,
  deleteSession, listMessages, listMessagesPage, userHasModule,
} from '../db.js';
import { getModule, DEFAULT_MODULE } from '../modules/registry.js';
import { sendError, clamp } from '../lib/validate.js';

function ownSession(req, reply, id) {
  const s = getSession(id);
  if (!s || s.user_id !== req.user.id) {
    sendError(reply, 'not_found', '会话不存在', 404);
    return null;
  }
  return s;
}

export default async function sessionRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get('/', auth, async (req) => {
    return { sessions: listSessions(req.user.id) };
  });

  fastify.post('/', auth, async (req, reply) => {
    const title = clamp((req.body?.title || '').trim(), 40);
    const pin = clamp(req.body?.pin || '', 2000);
    // 会话创建时绑定模块；默认中医（老行为）。开通校验在此做，避免聊天时才发现。
    const moduleId = clamp(String(req.body?.module || DEFAULT_MODULE).trim(), 20);
    const mod = getModule(moduleId);
    if (!mod) return sendError(reply, 'bad_module', '未知模块', 400);
    if (!userHasModule(req.user, moduleId)) {
      return sendError(reply, 'module_locked', `「${mod.name}」模块未开通，请联系管理员开通。`, 403);
    }
    const s = createSession(req.user.id, title || mod.name, pin, moduleId);
    return reply.code(201).send({ session: getSession(s.id) });
  });

  fastify.get('/:id', auth, async (req, reply) => {
    const s = ownSession(req, reply, req.params.id);
    if (!s) return;
    // 默认只回最近一页（长会话全量返回会让「点开历史」明显变慢）；
    // 传 before_id 向前翻页。all=1 保留旧行为（导出/兼容用）。
    const { limit, before_id: beforeId, all } = req.query || {};
    const base = {
      session: { id: s.id, title: s.title, pin: s.pin, created_at: s.created_at, module: s.module || 'tcm' },
    };
    if (all === '1') {
      return { ...base, messages: listMessages(s.id, 2000), total: null, has_more: false };
    }
    const page = listMessagesPage(s.id, { limit: limit ?? 60, beforeId: beforeId ?? null });
    return { ...base, messages: page.messages, total: page.total, has_more: page.has_more };
  });

  fastify.patch('/:id', auth, async (req, reply) => {
    const s = ownSession(req, reply, req.params.id);
    if (!s) return;
    const b = req.body || {};
    const title = clamp((b.title || '').trim(), 40);
    if (title) renameSession(s.id, title);
    // pin（问诊单/咨询背景摘要）：前端 setSessionPin 发的就是这个字段，
    // 之前这里只处理 title，导致固定的背景资料存不下来、每次都得随消息重发。
    if (b.pin !== undefined) updateSessionPin(s.id, clamp(String(b.pin || ''), 2000));
    return { ok: true };
  });

  fastify.delete('/:id', auth, async (req, reply) => {
    const s = ownSession(req, reply, req.params.id);
    if (!s) return;
    deleteSession(s.id);
    return { ok: true };
  });
}
