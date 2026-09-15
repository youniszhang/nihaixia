import { createUser, findUserByName, findUserById, getSetting, setSetting, isAdminUser, touchLogin, registrationAllowed, registrationRequiresBootstrap, configuredAdminUsername } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { issueToken, cookieOptions } from '../lib/auth.js';
import { isValidUsername, isValidPassword, sendError, clamp } from '../lib/validate.js';

function withRole(user) {
  return { ...user, is_admin: isAdminUser(user) };
}

// 公开站点配置：登录页据此显示/隐藏注册入口
function publicConfig() {
  return {
    registration_enabled: registrationAllowed(),
    bootstrap: registrationRequiresBootstrap(),
    // 仅提示是否由配置文件指定管理员，不泄露用户名
    admin_configured: Boolean(configuredAdminUsername()),
  };
}

export default async function authRoutes(fastify) {
  const rateOpts = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  fastify.get('/config', async () => publicConfig());

  fastify.post('/register', rateOpts, async (req, reply) => {
    // 注册开关：关闭后拒绝新注册；空库首启例外（否则无人能建管理员账号）
    if (!registrationAllowed()) {
      return sendError(reply, 'registration_closed', '本站已关闭注册，请联系管理员开通账号', 403);
    }
    const { username, password } = req.body || {};
    if (!isValidUsername(username)) return sendError(reply, 'bad_username', '用户名需 2-24 位，仅支持中英文、数字、下划线');
    if (!isValidPassword(password)) return sendError(reply, 'bad_password', '密码长度需 6-72 位');
    const name = username.trim();
    if (findUserByName(name)) return sendError(reply, 'username_taken', '该用户名已被注册', 409);

    const hash = await hashPassword(password);
    const user = createUser(name, hash);
    // 兼容老部署：空库首个注册用户记为 admin_user_id。
    // 若 .env 配了 ADMIN_USERNAME，则以配置文件为准（此记录不生效）。
    if (getSetting('admin_user_id') == null) setSetting('admin_user_id', String(user.id));
    touchLogin(user.id);
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
    if (user.status === 'disabled') return sendError(reply, 'account_disabled', '账号已被禁用，请联系管理员', 403);
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return sendError(reply, 'bad_credentials', '用户名或密码不正确', 401);
    touchLogin(user.id);
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
