// 管理员后台：用户管理 / 对话记录 / 用量报表
// 全部端点仅管理员可访问（isAdminUser），复用 /api/admin 前缀。
//
// 说明：管理员 = 第一个注册用户（settings.admin_user_id），或 ADMIN_USERNAME env。
// 这是单实例自托管应用，管理员拥有全站数据的查看与操作权限（含用户对话记录）。

import {
  isAdminUser, listUsersWithStats, setUserStatus, setUserNote, setUserPassword,
  deleteUser, findUserById, findUserByName, createUser, getSetting,
  getSession, adminListSessions, adminGetSessionMessages, adminSearchMessages,
  usageSummary, usageDaily, usageByUser, usageByProvider,
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
    };
  });

  // ---------- 用户管理 ----------
  fastify.get('/users', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const users = listUsersWithStats();
    const adminId = getSetting('admin_user_id');
    return {
      users: users.map((u) => ({
        ...u,
        is_admin: String(u.id) === String(adminId)
          || (process.env.ADMIN_USERNAME && u.username === process.env.ADMIN_USERNAME),
      })),
    };
  });

  fastify.post('/users', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { username, password } = req.body || {};
    if (!isValidUsername(username)) return sendError(reply, 'bad_username', '用户名需 2-24 位，仅支持中英文、数字、下划线');
    if (!isValidPassword(password)) return sendError(reply, 'bad_password', '密码长度需 6-72 位');
    const name = username.trim();
    if (findUserByName(name)) return sendError(reply, 'username_taken', '该用户名已被注册', 409);
    const hash = await hashPassword(password);
    const user = createUser(name, hash);
    return reply.code(201).send({ user: findUserById(user.id) });
  });

  fastify.patch('/users/:id', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const target = findUserById(id);
    if (!target) return sendError(reply, 'not_found', '用户不存在', 404);
    const b = req.body || {};

    if (b.status != null && !['active', 'disabled'].includes(b.status)) {
      return sendError(reply, 'bad_status', '状态仅支持 active / disabled');
    }
    // 不允许管理员禁用自己，避免自锁
    if (b.status === 'disabled' && String(id) === String(req.user.id)) {
      return sendError(reply, 'self_disable', '不能禁用当前登录的管理员账号');
    }
    if (b.status != null) setUserStatus(id, b.status);
    if (b.note != null) setUserNote(id, clamp(String(b.note), 200));
    if (b.password != null && String(b.password).length) {
      if (!isValidPassword(String(b.password))) return sendError(reply, 'bad_password', '密码长度需 6-72 位');
      setUserPassword(id, await hashPassword(String(b.password)));
    }
    return { user: listUsersWithStats().find((u) => u.id === id) || null };
  });

  fastify.delete('/users/:id', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const target = findUserById(id);
    if (!target) return sendError(reply, 'not_found', '用户不存在', 404);
    if (String(id) === String(req.user.id)) return sendError(reply, 'self_delete', '不能删除当前登录的管理员账号');
    const adminId = getSetting('admin_user_id');
    if (adminId != null && String(id) === String(adminId)) {
      return sendError(reply, 'admin_delete', '不能删除管理员账号');
    }
    deleteUser(id); // 级联删除 sessions / messages / profile / usage_log
    return { ok: true };
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
}
