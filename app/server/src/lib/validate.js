// Minimal input validation helpers (no dependency)
export function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(u.trim());
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
