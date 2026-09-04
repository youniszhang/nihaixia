import {
  createSession, listSessions, getSession, renameSession,
  deleteSession, listMessages,
} from '../db.js';
import { sendError, clamp } from '../lib/validate.js';

function ownSession(req, reply, id) {
  const s = getSession(id);
  if (!s || s.user_id !== req.user.id) {
    sendError(reply, 'not_found', '问诊会话不存在', 404);
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
    const title = clamp((req.body?.title || '新问诊').trim(), 40) || '新问诊';
    const pin = clamp(req.body?.pin || '', 2000);
    const s = createSession(req.user.id, title, pin);
    return reply.code(201).send({ session: getSession(s.id) });
  });

  fastify.get('/:id', auth, async (req, reply) => {
    const s = ownSession(req, reply, req.params.id);
    if (!s) return;
    return {
      session: { id: s.id, title: s.title, pin: s.pin, created_at: s.created_at },
      messages: listMessages(s.id, 500),
    };
  });

  fastify.patch('/:id', auth, async (req, reply) => {
    const s = ownSession(req, reply, req.params.id);
    if (!s) return;
    const title = clamp((req.body?.title || '').trim(), 40);
    if (title) renameSession(s.id, title);
    return { ok: true };
  });

  fastify.delete('/:id', auth, async (req, reply) => {
    const s = ownSession(req, reply, req.params.id);
    if (!s) return;
    deleteSession(s.id);
    return { ok: true };
  });
}
