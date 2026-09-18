import {
  createUser, findUserByName, findUserByNameCI, isReservedAdminName, findUserById, deleteUser,
  getSetting, setSetting, isAdminUser, touchLogin,
  registrationAllowed, registrationRequiresBootstrap, configuredAdminUsername, applyDefaultCredits,
  checkInviteCode, consumeInviteCode, inviteRequired, bumpTokenVersion,
} from '../db.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { issueToken, cookieOptions } from '../lib/auth.js';
import { isValidUsername, isValidPassword, sendError, clamp } from '../lib/validate.js';
import { loginLockRemaining, recordLoginFailure, clearLoginFailures } from '../lib/throttle.js';

const INVITE_MSG = {
  invalid: '邀请码无效',
  disabled: '该邀请码已被停用',
  expired: '该邀请码已过期',
  used: '该邀请码已被使用',
};

function withRole(user) {
  return { ...user, is_admin: isAdminUser(user) };
}

// 公开站点配置：登录页据此显示/隐藏注册入口与邀请码输入框
function publicConfig() {
  return {
    registration_enabled: registrationAllowed(),
    bootstrap: registrationRequiresBootstrap(),
    // 是否必须邀请码（空库首启例外：否则没人能建第一个账号）
    invite_required: inviteRequired() && !registrationRequiresBootstrap(),
    // 仅提示是否由配置文件指定管理员，不泄露用户名
    admin_configured: Boolean(configuredAdminUsername()),
  };
}

export default async function authRoutes(fastify) {
  const rateOpts = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  // 登录单独收紧（爆破的主要目标）；注册保留 20/min
  const loginRateOpts = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  fastify.get('/config', async () => publicConfig());

  fastify.post('/register', rateOpts, async (req, reply) => {
    // 空库首启例外（否则无人能建管理员账号）
    const bootstrap = registrationRequiresBootstrap();
    const { username, password, invite_code: inviteCode } = req.body || {};
    const code = clamp(String(inviteCode || '').trim().toUpperCase(), 64);

    // 注册总闸：显式关闭后仍允许「凭邀请码」注册（等于管理员定向开放）
    if (!registrationAllowed() && !bootstrap && !code) {
      return sendError(reply, 'registration_closed', '本站已关闭注册，请联系管理员获取邀请码', 403);
    }
    if (!isValidUsername(username)) return sendError(reply, 'bad_username', '用户名需 2-24 位（中英文、数字、下划线），或使用邮箱地址');
    if (!isValidPassword(password)) return sendError(reply, 'bad_password', '密码长度需 6-72 位');
    const name = username.trim();
    // 大小写不敏感查重（安全）：ADMIN_USERNAME=alice 时若允许注册 ALICE，
    // 该账号会命中 isAdminUser 的大小写不敏感判定 —— 直接拿到管理员权限（已实测复现）。
    if (findUserByNameCI(name)) return sendError(reply, 'username_taken', '该用户名已被注册', 409);
    // 保留名：配置的管理员名在本人注册前不许被大小写变体占用（同上漏洞的另一半）
    if (isReservedAdminName(name)) {
      return sendError(
        reply, 'username_reserved',
        '该用户名为保留的管理员账号名，请在服务器 .env 中使用完全一致的拼写注册',
        409,
      );
    }

    // 邀请码：空库首启免；管理员显式「开放注册（无需邀请码）」免
    const needInvite = !bootstrap && inviteRequired();
    if (needInvite) {
      if (!code) return sendError(reply, 'invite_required', '本站需邀请码才能注册，请向管理员获取', 403);
      // 先纯校验一次，避免「用户名密码都通过、最后才发现码无效」再回滚用户
      const pre = checkInviteCode(code);
      if (!pre.ok) return sendError(reply, `invite_${pre.reason}`, INVITE_MSG[pre.reason] || '邀请码不可用', 403);
    }

    const hash = await hashPassword(password);
    const user = createUser(name, hash);
    // 兼容老部署：空库首个注册用户记为 admin_user_id。
    // 若 .env 配了 ADMIN_USERNAME，则以配置文件为准（此记录不生效）。
    if (getSetting('admin_user_id') == null) setSetting('admin_user_id', String(user.id));

    // 消费邀请码（原子）。并发下若刚被别人用掉，则回滚刚创建的用户，避免无码注册。
    if (needInvite) {
      const used = consumeInviteCode(code, user.id);
      if (!used.ok) {
        try { deleteUser(user.id); } catch { /* ignore */ }
        return sendError(reply, `invite_${used.reason}`, INVITE_MSG[used.reason] || '邀请码不可用', 403);
      }
    }

    // 开户额度：站点设了 default_credits 才生效（留空 = 不限次）
    try { applyDefaultCredits(user.id); } catch { /* 开户失败不影响注册 */ }
    touchLogin(user.id);
    const token = issueToken(user);
    reply.setCookie('nhx_token', token, cookieOptions);
    return { user: withRole({ id: user.id, username: user.username }) };
  });

  fastify.post('/login', loginRateOpts, async (req, reply) => {
    // 登录不做格式校验（格式规则只在注册时生效）：历史账号、含特殊字符或
    // 短口令的账号同样能登录，凭据正确与否由下面的查库 + 校验决定。
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return sendError(reply, 'bad_credentials', '用户名或密码不正确', 401);
    }
    const name = username.trim();
    // 账号维度失败节流（安全）：IP 可被伪造/共享，账号维度不能。
    // 这里用 req.ip 而非 socket 地址 —— 反代后 socket 地址是代理 IP，
    // 会导致「攻击者失败几次就把全部用户锁住」的误伤。
    const acctKey = `acct:${name.toLowerCase()}`;
    const ipKey = `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const lockMs = Math.max(loginLockRemaining(acctKey), loginLockRemaining(ipKey));
    if (lockMs > 0) {
      return sendError(
        reply, 'too_many_attempts',
        `尝试次数过多，请在 ${Math.ceil(lockMs / 1000)} 秒后重试`,
        429,
      );
    }
    const user = findUserByName(name);
    if (!user) {
      recordLoginFailure(acctKey); recordLoginFailure(ipKey);
      return sendError(reply, 'bad_credentials', '用户名或密码不正确', 401);
    }
    if (user.status === 'disabled') return sendError(reply, 'account_disabled', '账号已被禁用，请联系管理员', 403);
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      recordLoginFailure(acctKey); recordLoginFailure(ipKey);
      return sendError(reply, 'bad_credentials', '用户名或密码不正确', 401);
    }
    clearLoginFailures(acctKey); clearLoginFailures(ipKey);
    // 单点登录：同一账号只允许一处在线。递增 token 版本，先前签发的 token 立即失效。
    bumpTokenVersion(user.id);
    touchLogin(user.id);
    const token = issueToken({ ...user, __bumped: true });
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
