// 管理员后台：用户管理 / 对话记录 / 用量报表 / 站点设置 / 审计日志
// 全部端点仅管理员可访问（isAdminUser），复用 /api/admin 前缀。
//
// 管理员判定（重要变更 2026-09）：
//   由配置文件 .env 的 ADMIN_USERNAME 指定（唯一权威）。未配置时回退到
//   老部署行为（settings.admin_user_id = 第一个注册用户）。
//   因此「第一个注册的用户」不再自动获得管理员权限。

import {
  isAdminUser, listUsersWithStats, setUserStatus, setUserNote, setUserPassword,
  renameUser, deleteUser, findUserById, findUserByName, createUser, getSetting, setSetting, deleteSetting,
  getSession, adminListSessions, adminGetSessionMessages, adminSearchMessages,
  usageSummary, usageDaily, usageByUser, usageByProvider, usageUserDaily,
  bulkSetUserStatus, bulkDeleteUsers, addAudit, listAudit,
  registrationAllowed, registrationIsExplicit, configuredAdminUsername, isAdminIdentity,
  setUserCredits, setUserDailyLimit, getUserCredits, resolveQuota, applyDefaultCredits,
  listPlans, getPlan, createPlan, updatePlan, deletePlan,
  listSubscriptions, subscriptionStats, approveSubscription, rejectSubscription,
  cancelSubscriptionById, applySubscription, pendingSubscription, expireSubscriptions,
  getCheckinSettings, checkinSummary, checkinDaily, listCheckins, listCreditLog,
  createInviteCode, listInviteCodes, setInviteCodeDisabled, deleteInviteCode, inviteRequired,
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

// 把「按用户 × 按天」的扁平行转成折线图需要的结构：
//   { days: [...完整日期轴...], series: [{ user_id, username, calls: [...] }] }
// 日期轴必须补全（没有调用量的日子也要占位），否则折线会把缺口连起来、横轴失真。
function usersDailySeries(days) {
  const rows = usageUserDaily(days);
  const axis = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    // 用本地日期拼 YYYY-MM-DD（与 SQLite date(...,'localtime') 对齐）
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    axis.push(`${d.getFullYear()}-${m}-${day}`);
  }
  const idxOf = new Map(axis.map((d, i) => [d, i]));
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, {
        user_id: r.user_id,
        username: r.username,
        calls: new Array(axis.length).fill(0),
        prompt_chars: new Array(axis.length).fill(0),
        completion_chars: new Array(axis.length).fill(0),
      });
    }
    const i = idxOf.get(r.day);
    if (i == null) continue;
    const s = byUser.get(r.user_id);
    s.calls[i] = r.calls;
    s.prompt_chars[i] = r.prompt_chars;
    s.completion_chars[i] = r.completion_chars;
  }
  const series = [...byUser.values()].sort(
    (a, b) => b.calls.reduce((x, y) => x + y, 0) - a.calls.reduce((x, y) => x + y, 0),
  );
  return { days: axis, series };
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
    if (!isValidUsername(username)) return sendError(reply, 'bad_username', '用户名需 2-24 位（中英文、数字、下划线），或使用邮箱地址');
    if (!isValidPassword(password)) return sendError(reply, 'bad_password', '密码长度需 6-72 位');
    const name = username.trim();
    if (findUserByName(name)) return sendError(reply, 'username_taken', '该用户名已被注册', 409);
    const hash = await hashPassword(password);
    const user = createUser(name, hash);
    if (note != null) setUserNote(user.id, clamp(String(note), 200));
    // 新用户默认额度（站点设置 default_credits；留空 = 不限次）
    try { applyDefaultCredits(user.id); } catch { /* 开户失败不影响创建 */ }
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
      if (!isValidUsername(name)) return sendError(reply, 'bad_username', '用户名需 2-24 位（中英文、数字、下划线），或使用邮箱地址');
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

    // 额度：绝对值（credits=null/'' 表示不限次）或相对增量（credit_delta，可负）
    if (b.credits !== undefined) {
      const raw = b.credits;
      const next = (raw === null || raw === '') ? null : Math.max(0, Math.floor(Number(raw)));
      if (next !== null && !Number.isFinite(next)) return sendError(reply, 'bad_credits', '额度需为 0 或正整数（留空 = 不限次）');
      setUserCredits(id, next, 'admin', `管理员 ${req.user.username} 调整`);
      changes.push(next === null ? '额度改为不限次' : `额度设为 ${next} 次`);
    }
    if (b.credit_delta != null && b.credit_delta !== '' && b.credit_delta !== 0) {
      const delta = Math.floor(Number(b.credit_delta));
      if (!Number.isFinite(delta) || delta === 0) return sendError(reply, 'bad_delta', '增减额度需为非 0 整数');
      const cur = getUserCredits(id);
      if (cur === null) return sendError(reply, 'unlimited', '该账号为不限次，请先设定一个额度再增减', 400);
      const next = Math.max(0, cur + delta);
      setUserCredits(id, next, 'admin', `管理员 ${req.user.username} ${delta > 0 ? '增加' : '扣减'} ${Math.abs(delta)} 次`);
      changes.push(`额度 ${delta > 0 ? '+' : '−'}${Math.abs(delta)} → ${next} 次`);
    }

    // 每日上限：null = 跟随套餐/站点
    if (b.daily_chat_limit !== undefined) {
      const raw = b.daily_chat_limit;
      const next = (raw === null || raw === '') ? null : Math.max(0, Math.floor(Number(raw)));
      if (next !== null && !Number.isFinite(next)) return sendError(reply, 'bad_limit', '每日上限需为 0 或正整数');
      setUserDailyLimit(id, next);
      changes.push(next === null ? '每日上限跟随套餐/站点' : `每日上限设为 ${next || 0} 次${next ? '' : '（不限）'}`);
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
      users_daily: usersDailySeries(days),
      days,
    };
  });

  // ---------- 站点设置 ----------
  const siteState = () => {
    const cs = getCheckinSettings();
    return {
      registration_enabled: registrationAllowed(),
      registration_explicit: registrationIsExplicit(),
      admin_username: configuredAdminUsername(),
      admin_source: configuredAdminUsername() ? 'env' : 'legacy',
      daily_chat_limit: Number(getSetting('daily_chat_limit') || 0),
      // 签到 / 人机校验
      checkin_enabled: cs.enabled,
      checkin_reward: cs.reward,
      checkin_streak_bonus: cs.streakBonus,
      checkin_streak_bonus_max: cs.streakBonusMax,
      turnstile_site_key: cs.siteKey,
      // 只回「是否已配 secret」，不把密钥回传给浏览器
      turnstile_secret_set: Boolean(cs.secretKey),
      turnstile_active: cs.captchaEnabled,
      default_credits: getSetting('default_credits') ?? '',
    };
  };

  fastify.get('/site', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return siteState();
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
    if (b.daily_chat_limit != null) {
      const n = Math.min(Math.max(Math.floor(Number(b.daily_chat_limit) || 0), 0), 100000);
      setSetting('daily_chat_limit', String(n));
      addAudit({
        actor: req.user, action: 'site.daily_limit',
        target: `每日问诊上限 ${n}${n ? ' 次' : '（不限）'}`, detail: '',
      });
    }
    if (b.checkin_enabled != null) {
      setSetting('checkin_enabled', b.checkin_enabled ? 'true' : 'false');
      addAudit({ actor: req.user, action: 'site.checkin', target: b.checkin_enabled ? '开启签到' : '关闭签到', detail: '' });
    }
    for (const [key, field, label, max] of [
      ['checkin_reward', 'checkin_reward', '签到基础奖励', 1000],
      ['checkin_streak_bonus', 'checkin_streak_bonus', '连签加成', 1000],
      ['checkin_streak_bonus_max', 'checkin_streak_bonus_max', '加成上限', 1000],
    ]) {
      if (b[field] != null) {
        const n = Math.min(Math.max(Math.floor(Number(b[field]) || 0), 0), max);
        setSetting(key, String(n));
        addAudit({ actor: req.user, action: 'site.checkin', target: `${label} ${n}`, detail: '' });
      }
    }
    // 人机校验：只写非空值；显式传空串 = 清除
    if (b.turnstile_site_key != null) {
      const v = String(b.turnstile_site_key).trim().slice(0, 100);
      if (v) setSetting('turnstile_site_key', v); else deleteSetting('turnstile_site_key');
      addAudit({ actor: req.user, action: 'site.turnstile', target: v ? '设置 Site Key' : '清除 Site Key', detail: '' });
    }
    if (b.turnstile_secret_key != null) {
      const v = String(b.turnstile_secret_key).trim().slice(0, 200);
      if (v) setSetting('turnstile_secret_key', v); else deleteSetting('turnstile_secret_key');
      // 密钥本身不进审计详情，只记「有没有」
      addAudit({ actor: req.user, action: 'site.turnstile', target: v ? '设置 Secret Key' : '清除 Secret Key', detail: '' });
    }
    if (b.default_credits != null) {
      const raw = String(b.default_credits).trim();
      if (!raw) {
        deleteSetting('default_credits');
        addAudit({ actor: req.user, action: 'site.default_credits', target: '新用户默认额度：不限次', detail: '' });
      } else {
        const n = Math.min(Math.max(Math.floor(Number(raw) || 0), 0), 100000);
        setSetting('default_credits', String(n));
        addAudit({ actor: req.user, action: 'site.default_credits', target: `新用户默认额度 ${n} 次`, detail: '' });
      }
    }
    return { ok: true, ...siteState() };
  });

  // ---------- 套餐（订阅计划） ----------
  fastify.get('/plans', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { plans: listPlans({ includeInactive: true }) };
  });

  fastify.post('/plans', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const name = clamp(String(req.body?.name || '').trim(), 40);
    if (!name) return sendError(reply, 'bad_name', '请填写套餐名称');
    const plan = createPlan({
      name,
      description: clamp(String(req.body?.description || '').trim(), 200),
      priceCents: req.body?.price_cents,
      periodDays: req.body?.period_days,
      dailyChatLimit: req.body?.daily_chat_limit,
      credits: req.body?.credits,
      sort: req.body?.sort,
      active: req.body?.active !== false,
    });
    addAudit({ actor: req.user, action: 'plan.create', target: plan.name, detail: `${plan.period_days} 天 · ${plan.credits} 次额度 · 每日上限 ${plan.daily_chat_limit || '不限'}` });
    return reply.code(201).send({ plan });
  });

  fastify.patch('/plans/:id', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const plan = updatePlan(id, req.body || {});
    if (!plan) return sendError(reply, 'not_found', '套餐不存在', 404);
    addAudit({ actor: req.user, action: 'plan.update', target: plan.name, detail: '已更新套餐' });
    return { plan };
  });

  fastify.delete('/plans/:id', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const plan = getPlan(id);
    if (!plan) return sendError(reply, 'not_found', '套餐不存在', 404);
    // 已售出的订阅保留快照，删除套餐不影响老订阅（plan_id 置空即可）
    deletePlan(id);
    addAudit({ actor: req.user, action: 'plan.delete', target: plan.name, detail: '删除套餐（老订阅不受影响）' });
    return { ok: true };
  });

  // ---------- 订阅管理 ----------
  fastify.get('/subscriptions', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    expireSubscriptions();
    const status = ['pending', 'active', 'rejected', 'expired', 'canceled'].includes(String(req.query?.status))
      ? String(req.query.status) : null;
    return {
      subscriptions: listSubscriptions({ userId: req.query?.user_id ? Number(req.query.user_id) : null, status, limit: req.query?.limit }),
      stats: subscriptionStats(),
    };
  });

  // 直接为某用户开通（管理员线下收款后发放）：等同「申请 + 审批通过」
  fastify.post('/users/:id/subscribe', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const target = findUserById(id);
    if (!target) return sendError(reply, 'not_found', '用户不存在', 404);
    const plan = getPlan(Number(req.body?.plan_id));
    if (!plan) return sendError(reply, 'no_plan', '套餐不存在', 404);
    // 走与用户自助完全相同的入口，避免两条发放路径出现差异
    const pending = pendingSubscription(id);
    if (pending) cancelSubscriptionById(pending.id);
    const ap = applySubscription(id, plan.id, clamp(String(req.body?.note || '').trim(), 200) || `管理员 ${req.user.username} 开通`);
    if (!ap.ok) return sendError(reply, 'subscribe_failed', '开通失败，请稍后重试', 400);
    const done = approveSubscription(ap.id, req.user.username);
    addAudit({
      actor: req.user, action: 'subscription.grant', target: target.username,
      detail: `开通套餐「${plan.name}」，到期 ${done.expires_at || '—'}`,
    });
    return { ok: true, subscription: listSubscriptions({ userId: id, limit: 1 })[0] || null };
  });

  fastify.post('/subscriptions/:id/approve', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const sub = listSubscriptions({ limit: 500 }).find((s) => s.id === id);
    if (!sub) return sendError(reply, 'not_found', '订阅不存在', 404);
    const r = approveSubscription(id, req.user.username);
    if (!r.ok) return sendError(reply, 'approve_failed', r.code === 'already_active' ? '该订阅已生效' : '审批失败', 400);
    addAudit({ actor: req.user, action: 'subscription.approve', target: sub.username, detail: `套餐「${sub.plan_name}」到期 ${r.expires_at || '—'}` });
    return { ok: true, ...r };
  });

  fastify.post('/subscriptions/:id/reject', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const sub = listSubscriptions({ limit: 500 }).find((s) => s.id === id);
    if (!sub) return sendError(reply, 'not_found', '订阅不存在', 404);
    const r = rejectSubscription(id, clamp(String(req.body?.reason || '').trim(), 200));
    if (!r.ok) return sendError(reply, 'reject_failed', '仅待审批的申请可以驳回', 400);
    addAudit({ actor: req.user, action: 'subscription.reject', target: sub.username, detail: `驳回套餐「${sub.plan_name}」` });
    return { ok: true };
  });

  fastify.post('/subscriptions/:id/cancel', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const sub = listSubscriptions({ limit: 500 }).find((s) => s.id === id);
    if (!sub) return sendError(reply, 'not_found', '订阅不存在', 404);
    cancelSubscriptionById(id);
    addAudit({ actor: req.user, action: 'subscription.cancel', target: sub.username, detail: `撤销套餐「${sub.plan_name}」（${sub.status}）` });
    return { ok: true };
  });

  // 单个用户的额度/订阅明细（后台用户行展开用）
  fastify.get('/users/:id/quota', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const target = findUserById(id);
    if (!target) return sendError(reply, 'not_found', '用户不存在', 404);
    return {
      user: { id: target.id, username: target.username },
      quota: resolveQuota(id),
      subscriptions: listSubscriptions({ userId: id, limit: 20 }),
      checkins: listCheckins(id, 30),
      ledger: listCreditLog(id, 50),
    };
  });

  // ---------- 签到报表 ----------
  fastify.get('/checkins', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const days = Math.min(Math.max(Number(req.query?.days) || 14, 1), 90);
    return {
      summary: checkinSummary(),
      daily: checkinDaily(days),
      // 密钥不回传，只说明「已配置」
      settings: (() => { const s = getCheckinSettings(); return { ...s, secretKey: undefined, secret_set: Boolean(s.secretKey) }; })(),
      days,
    };
  });

  // ---------- 审计日志 ----------
  fastify.get('/audit', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const limit = Math.min(Number(req.query?.limit) || 100, 500);
    return { logs: listAudit(limit) };
  });

  // ---------- 邀请码 ----------
  fastify.get('/invites', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return {
      invites: listInviteCodes(Math.min(Number(req.query?.limit) || 200, 500)),
      invite_required: inviteRequired(),
    };
  });

  fastify.post('/invites', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = req.body || {};
    const maxUses = Math.min(Math.max(Math.floor(Number(b.max_uses) || 1), 1), 1000);
    // 有效期：传天数则换算成绝对时间（默认 7 天；0/空 = 永不过期）
    let expiresAt = null;
    const days = Number(b.expires_in_days);
    if (b.expires_in_days != null && b.expires_in_days !== '' && days > 0) {
      expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    }
    const created = createInviteCode({
      note: b.note, maxUses, expiresAt, createdBy: req.user.username,
    });
    addAudit({
      actor: req.user, action: 'invite.create',
      target: created.code, detail: `可用 ${maxUses} 次，有效期 ${expiresAt || '永久'}`,
    });
    return reply.code(201).send({ invite: created });
  });

  fastify.patch('/invites/:id', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    if (b.disabled != null) {
      setInviteCodeDisabled(id, Boolean(b.disabled));
      addAudit({ actor: req.user, action: 'invite.toggle', target: `#${id}`, detail: b.disabled ? '停用' : '启用' });
    }
    return { ok: true };
  });

  fastify.delete('/invites/:id', admin, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    deleteInviteCode(id);
    addAudit({ actor: req.user, action: 'invite.delete', target: `#${id}`, detail: '' });
    return { ok: true };
  });
}
