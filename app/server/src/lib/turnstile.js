// Cloudflare Turnstile 人机校验（签到防刷）。
// 站点设置里 site key 与 secret 都配好才启用；只配一半时调用方会直接放行，
// 避免「配置不全」把全部用户挡在签到门外。
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(secret, token, remoteIp = '') {
  if (!secret) return { ok: false, code: 'no_secret' };
  if (!token) return { ok: false, code: 'missing_token' };
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(data.success),
      code: data.success ? 'ok' : 'rejected',
      errorCodes: data['error-codes'] || [],
      hostname: data.hostname || '',
    };
  } catch (err) {
    // 校验服务不可达：按「不通过」处理（宁可挡一下，也不放机器人进来）
    return { ok: false, code: 'network', errorCodes: [String(err.message || err).slice(0, 120)] };
  }
}
