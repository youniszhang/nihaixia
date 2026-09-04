import crypto from 'node:crypto';
import config from '../config.js';

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
export function sign(payloadB64) {
  return crypto.createHmac('sha256', config.secret).update(payloadB64).digest('base64url');
}

export function issueToken(user) {
  const payload = { uid: user.id, un: user.username, exp: Date.now() + TOKEN_TTL_MS };
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
