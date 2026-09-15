import crypto from 'node:crypto';
import config from '../config.js';
import { getUserStatus, getUserTokenVersion } from '../db.js';

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
export function sign(payloadB64) {
  return crypto.createHmac('sha256', config.secret).update(payloadB64).digest('base64url');
}

export function issueToken(user) {
  // tv = token_version：改密/禁用后服务端递增，旧 token 立即失效
  const tv = getUserTokenVersion(user.id);
  const payload = { uid: user.id, un: user.username, exp: Date.now() + TOKEN_TTL_MS };
  if (tv != null) payload.tv = tv;
  const p = b64url(JSON.stringify(payload));
  return `${p}.${sign(p)}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [p, sig] = token.split('.');
  if (sign(p) !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function createAuthenticate() {
  return async (req, reply) => {
    const token = req.cookies?.nhx_token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const payload = verifyToken(token);
    if (!payload) {
      return reply.code(401).send({ error: 'unauthorized', message: '请先登录' });
    }
    // 已签发的 token 也要校验当前状态：管理员禁用用户后立即生效
    const status = getUserStatus(payload.uid);
    if (status === null || status === 'disabled') {
      return reply.code(401).send({ error: 'account_disabled', message: '账号已被禁用，请联系管理员' });
    }
    // token 版本校验：改密后旧 token 全部失效
    const tv = getUserTokenVersion(payload.uid);
    if (tv != null && Number(payload.tv || 0) !== tv) {
      return reply.code(401).send({ error: 'token_revoked', message: '登录状态已失效，请重新登录' });
    }
    req.user = { id: payload.uid, username: payload.un };
  };
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.COOKIE_SECURE === 'true',
  path: '/',
  maxAge: Math.floor(TOKEN_TTL_MS / 1000),
};
