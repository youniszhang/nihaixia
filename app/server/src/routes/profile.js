import { getProfile, upsertProfile } from '../db.js';
import { sendError, clamp } from '../lib/validate.js';

export default async function profileRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get('/', auth, async (req) => {
    return { profile: getProfile(req.user.id) };
  });

  fastify.put('/', auth, async (req, reply) => {
    const b = req.body || {};
    const age = b.age === null || b.age === '' ? null : Number(b.age);
    const height = b.height_cm === null || b.height_cm === '' ? null : Number(b.height_cm);
    const weight = b.weight_kg === null || b.weight_kg === '' ? null : Number(b.weight_kg);
    if (age !== null && (!Number.isFinite(age) || age < 1 || age > 120)) {
      return sendError(reply, 'bad_age', '年龄需在 1-120 之间');
    }
    upsertProfile(req.user.id, {
      nickname: clamp(b.nickname || '', 20),
      gender: clamp(b.gender || '', 4),
      age,
      height_cm: height,
      weight_kg: weight,
      body_notes: clamp(b.body_notes || '', 500),
    });
    return { profile: getProfile(req.user.id) };
  });
}
