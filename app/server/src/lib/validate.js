// Minimal input validation helpers (no dependency)

// 用户名规则：
//   1) 普通用户名 —— 2-24 位中英文、数字、下划线
//   2) 邮箱地址  —— 形如 name@example.com（最长 64 位）
// 邮箱作为账号便于记忆与管理员指定（.env 的 ADMIN_USERNAME）。
const PLAIN_USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/;
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

export function isValidUsername(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (s.length < 2 || s.length > 64) return false;
  if (s.includes('@')) return EMAIL_RE.test(s);
  return PLAIN_USERNAME_RE.test(s);
}
export function isValidPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 72;
}
export function clamp(str, max) {
  if (typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) : str;
}
export function sendError(reply, code, message, statusCode = 400) {
  return reply.code(statusCode).send({ error: code, message });
}
