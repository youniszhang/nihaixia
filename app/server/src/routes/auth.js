import argon2 from 'argon2';
import { createUser, findUserByName, findUserById, getSetting, setSetting, isAdminUser } from '../db.js';
import { issueToken, cookieOptions } from '../lib/auth.js';
import { isValidUsername, isValidPassword, sendError, clamp } from '../lib/validate.js';

function withRole(user) {
  return { ...user, is_admin: isAdminUser(user) };
}

export default async function authRoutes(fastify) {
  const rateOpts = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  fastify.post('/register', rateOpts, async (req, reply) => {
    const { username, password } = req.body || {};
    if (!isValidUsername(username)) return sendError(reply, 'bad_username', '用户名需 2-24 位，仅支持中英文、数字、下划线');
    if (!isValidPassword(password)) return sendError(reply, 'bad_password', '密码长度需 6-72 位');
    const name = username.trim();
    if (findUserByName(name)) return sendError(reply, 'username_taken', '该用户名已被注册', 409);

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const user = createUser(name, hash);
    // First registered user automatically becomes admin
    if (getSetting('admin_user_id') == null) setSetting('admin_user_id', String(user.id));
    const token = issueToken(user);
    reply.setCookie('nhx_token', token, cookieOptions);
    return { user: withRole({ id: user.id, username: user.username }) };
  });

  fastify.post('/login', rateOpts, async (req, reply) => {
    const { username, password } = req.body || {};
    if (!isValidUsername(username) || !isValidPassword(password)) {
      return sendError(reply, 'bad_credentials', '用户名或密码不正确', 401);
    }
    const user = findUserByName(username.trim());
    if (!user) return sendError(reply, 'bad_credentials', '用户名或密码不正确', 401);
    const ok = await argon2.verify(user.password_hash, password).catch(() => false);
    if (!ok) return sendError(reply, 'bad_credentials', '用户名或密码不正确', 401);
    const token = issueToken(user);
    reply.setCookie('nhx_token', token, cookieOptions);
    return { user: withRole({ id: user.id, username: user.username }) };
  });

  fastify.post('/logout', async (req, reply) => {
    reply.clearCookie('nhx_token', { path: '/' });
    return { ok: true };
  });

  fastify.get('/me', { preHandler: [fastify.authenticate] }, async (req) => {
    const u = findUserById(req.user.id);
    return { user: u ? withRole(u) : null };
  });
}
