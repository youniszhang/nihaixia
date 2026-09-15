// 管理员后台：用户管理 / 对话记录 / 用量报表 / 站点设置 / 审计日志
// 全部端点仅管理员可访问（isAdminUser），复用 /api/admin 前缀。
//
// 管理员判定（重要变更 2026-09）：
//   由配置文件 .env 的 ADMIN_USERNAME 指定（唯一权威）。未配置时回退到
//   老部署行为（settings.admin_user_id = 第一个注册用户）。
//   因此「第一个注册的用户」不再自动获得管理员权限。

import {
  isAdminUser, listUsersWithStats, setUserStatus, setUserNote, setUserPassword,
  renameUser, deleteUser, findUserById, findUserByName, createUser, getSetting, setSetting,
  getSession, adminListSessions, adminGetSessionMessages, adminSearchMessages,
  usageSummary, usageDaily, usageByUser, usageByProvider,
  bulkSetUserStatus, bulkDeleteUsers, addAudit, listAudit,
  registrationAllowed, registrationIsExplicit, configuredAdminUsername, isAdminIdentity,
} from '../db.js';
import { hashPassword } from '../lib/password.js';
import { isValidUsername, isValidPassword, sendError, clamp } from '../lib/validate.js';

// 与 routes/admin.js 相同的守卫模式：authenticate 作 preHandler，
// 处理函数内再做管理员判定（避免 preHandler 内二次 send 的风险）。
function requireAdmin(req, reply) {
  if (!isAdminUser(req.user)) {
    sendError(reply, 'forbidden', '仅管理员可访问', 403);
    return false;
  }
  return true;
}

function isConfiguredAdmin(username) {
  return isAdminIdentity({ username });
}

// 目标用户是否为管理员身份（与登录判定同源，避免"后台认为不是、登录认为是"的漂移）
// 配置了 ADMIN_USERNAME 时，老 settings.admin_user_id 记录不再算管理员。
function targetIsAdmin(target) {
  return isAdminIdentity(target);
}

export default async function adminUserRoutes(fastify) {
  const admin = { preHandler: [fastify.authenticate] };

  // ---------- 概览 ----------
  fastify.get('/overview', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const users = listUsersWithStats();
    const usage = usageSummary();
    const { total: sessionTotal } = adminListSessions({ limit: 1, offset: 0 });
    const activeUsers = users.filter((u) => u.status !== 'disabled').length;
    const today = usageDaily(1)[0] || { calls: 0, users: 0 };
    return {
      users: { total: users.length, active: activeUsers, disabled: users.length - activeUsers },
      sessions: { total: sessionTotal },
      usage: { ...usage, today_calls: today.calls || 0, today_users: today.users || 0 },
      provider: getSetting('llm_provider') === 'dsweb' ? 'dsweb' : 'api',
      model: getSetting('llm_model') || '',
      registration_enabled: registrationAllowed(),
      admin_configured: Boolean(configuredAdminUsername()),
      admin_username: configuredAdminUsername(),
    };
  });

  // ---------- 用户管理 ----------
  fastify.get('/users', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const users = listUsersWithStats();
    return {
      users: users.map((u) => ({
        ...u,
        // 与登录态判定同源，避免"列表说不是管理员、登录后是"的不一致
        is_admin: isAdminIdentity(u),
        is_self: String(u.id) === String(req.user.id),
      })),
      admin_source: configuredAdminUsername() ? 'env' : 'legacy',
    };
  });

  fastify.post('/users', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { username, password, note } = req.body || {};
    if (!isValidUsername(username)) return sendError(reply, 'bad_username', '用户名需 2-24 位，仅支持中英文、数字、下划线');
    if (!isValidPassword(password)) return sendError(reply, 'bad_password', '密码长度需 6-72 位');
    const name = username.trim();
    if (findUserByName(name)) return sendError(reply, 'username_taken', '该用户名已被注册', 409);
    const hash = await hashPassword(password);
    const user = createUser(name, hash);
    if (note != null) setUserNote(user.id, clamp(String(note), 200));
    addAudit({ actor: req.user, action: 'user.create', target: name, detail: '管理员创建账号' });
    return reply.code(201).send({ user: listUsersWithStats().find((u) => u.id === user.id) || findUserById(user.id) });
  });

  fastify.patch('/users/:id', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const target = findUserById(id);
    if (!target) return sendError(reply, 'not_found', '用户不存在', 404);
    const full = listUsersWithStats().find((u) => u.id === id);
    const b = req.body || {};
    const isSelf = String(id) === String(req.user.id);
    const targetAdmin = targetIsAdmin(full || target);
    const changes = [];

    if (b.status != null) {
      if (!['active', 'disabled'].includes(b.status)) return sendError(reply, 'bad_status', '状态仅支持 active / disabled');
      // 不允许禁用自己，或禁用配置文件指定的管理员
      if (b.status === 'disabled') {
        if (isSelf) return sendError(reply, 'self_disable', '不能禁用当前登录的管理员账号');
        if (targetAdmin) return sendError(reply, 'admin_disable', '不能禁用管理员账号（由配置文件 ADMIN_USERNAME 指定）');
      }
      setUserStatus(id, b.status);
      changes.push(b.status === 'disabled' ? '已禁用' : '已启用');
    }

    if (b.username != null) {
      const name = String(b.username).trim();
      if (!isValidUsername(name)) return sendError(reply, 'bad_username', '用户名需 2-24 位，仅支持中英文、数字、下划线');
      if (name !== target.username) {
        if (targetAdmin) return sendError(reply, 'admin_rename', '不能重命名管理员账号（请直接改 .env 的 ADMIN_USERNAME）');
        const dup = findUserByName(name);
        if (dup && dup.id !== id) return sendError(reply, 'username_taken', '该用户名已被注册', 409);
        renameUser(id, name);
        changes.push(`改名 ${target.username} → ${name}`);
      }
    }

    if (b.note != null) {
      setUserNote(id, clamp(String(b.note), 200));
      changes.push('备注已更新');
    }

    if (b.password != null && String(b.password).length) {
      if (!isValidPassword(String(b.password))) return sendError(reply, 'bad_password', '密码长度需 6-72 位');
      setUserPassword(id, await hashPassword(String(b.password)));
      changes.push('密码已重置（旧登录已失效）');
    }

    if (changes.length) addAudit({ actor: req.user, action: 'user.update', target: target.username, detail: changes.join('；') });
    return { user: listUsersWithStats().find((u) => u.id === id) || null, changes };
  });

  fastify.delete('/users/:id', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const target = findUserById(id);
    if (!target) return sendError(reply, 'not_found', '用户不存在', 404);
    if (String(id) === String(req.user.id)) return sendError(reply, 'self_delete', '不能删除当前登录的管理员账号');
    const full = listUsersWithStats().find((u) => u.id === id);
    if (targetIsAdmin(full || target)) {
      return sendError(reply, 'admin_delete', '不能删除管理员账号（由配置文件 ADMIN_USERNAME 指定）');
    }
    deleteUser(id); // 级联删除 sessions / messages / profile / usage_log
    addAudit({ actor: req.user, action: 'user.delete', target: target.username, detail: '删除账号及其全部问诊记录' });
    return { ok: true };
  });

  // 批量操作：{ ids: [...], action: 'disable'|'enable'|'delete' }
  fastify.post('/users/bulk', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    const action = req.body?.action;
    if (!ids.length) return sendError(reply, 'bad_request', '请选择要操作的用户');
    if (!['disable', 'enable', 'delete'].includes(action)) return sendError(reply, 'bad_action', '不支持的操作');

    const users = listUsersWithStats();
    const selfId = String(req.user.id);
    const skipped = [];
    const valid = [];
    for (const id of ids) {
      const u = users.find((x) => x.id === id);
      if (!u) { skipped.push(`#${id}（不存在）`); continue; }
      if (String(id) === selfId) { skipped.push(`${u.username}（当前登录账号）`); continue; }
      if (targetIsAdmin(u)) { skipped.push(`${u.username}（管理员账号）`); continue; }
      valid.push(id);
    }
    if (!valid.length) {
      return sendError(reply, 'no_valid_target', `没有可操作的用户：${skipped.join('、')}`, 400);
    }

    let affected = 0;
    if (action === 'delete') affected = bulkDeleteUsers(valid);
    else affected = bulkSetUserStatus(valid, action === 'disable' ? 'disabled' : 'active');

    const label = { disable: '批量禁用', enable: '批量启用', delete: '批量删除' }[action];
    addAudit({
      actor: req.user,
      action: `user.bulk_${action}`,
      target: `${affected} 个账号`,
      detail: skipped.length ? `跳过：${skipped.join('、')}` : '全部成功',
    });
    return { ok: true, affected, skipped, message: `${label}完成：${affected} 个账号${skipped.length ? `，跳过 ${skipped.length} 个` : ''}` };
  });

  // ---------- 对话记录 ----------
  fastify.get('/conversations', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const userId = req.query?.user_id ? Number(req.query.user_id) : null;
    const q = clamp(String(req.query?.q || '').trim(), 60);
    const limit = Math.min(Number(req.query?.limit) || 50, 200);
    const offset = Math.max(Number(req.query?.offset) || 0, 0);
    const { rows, total } = adminListSessions({ userId, q, limit, offset });
    return { conversations: rows, total, limit, offset };
  });

  fastify.get('/conversations/:id', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const s = getSession(req.params.id);
    if (!s) return sendError(reply, 'not_found', '会话不存在', 404);
    const owner = findUserById(s.user_id);
    return {
      session: { ...s, username: owner?.username || `#${s.user_id}` },
      messages: adminGetSessionMessages(s.id),
    };
  });

  fastify.get('/search', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = clamp(String(req.query?.q || '').trim(), 60);
    if (q.length < 2) return sendError(reply, 'bad_query', '请输入至少 2 个字符');
    return { results: adminSearchMessages(q, 80) };
  });

  // ---------- 报表 ----------
  fastify.get('/reports', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const days = Math.min(Math.max(Number(req.query?.days) || 14, 1), 90);
    return {
      summary: usageSummary(),
      daily: usageDaily(days),
      by_user: usageByUser(),
      by_provider: usageByProvider(),
      days,
    };
  });

  // ---------- 站点设置 ----------
  fastify.get('/site', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return {
      registration_enabled: registrationAllowed(),
      registration_explicit: registrationIsExplicit(),
      admin_username: configuredAdminUsername(),
      admin_source: configuredAdminUsername() ? 'env' : 'legacy',
    };
  });

  fastify.put('/site', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = req.body || {};
    if (b.registration_enabled != null) {
      setSetting('registration_enabled', b.registration_enabled ? 'true' : 'false');
      addAudit({
        actor: req.user, action: 'site.registration',
        target: b.registration_enabled ? '开启注册' : '关闭注册', detail: '',
      });
    }
    return {
      ok: true,
      registration_enabled: registrationAllowed(),
      registration_explicit: registrationIsExplicit(),
      admin_username: configuredAdminUsername(),
      admin_source: configuredAdminUsername() ? 'env' : 'legacy',
    };
  });

  // ---------- 审计日志 ----------
  fastify.get('/audit', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const limit = Math.min(Number(req.query?.limit) || 100, 500);
    return { logs: listAudit(limit) };
  });
}
