// 用户订阅：查看套餐 / 申请开通 / 查看自己的订阅与额度。
//
// GET  /api/subscription          —— 套餐列表 + 我的订阅 + 待审批申请 + 额度概览
// POST /api/subscription/apply    —— 提交开通申请（进入待审批，由管理员在后台通过）
// POST /api/subscription/cancel   —— 撤回自己待审批的申请
//
// 说明：本站不做在线支付，申请制 + 管理员开通（额度与有效期由套餐快照决定）。
// 这与 sub2api 的「用户余额/套餐」模型一致，只是把充值入口换成了人工审批。

import {
  listPlans, activeSubscription, pendingSubscription,
  applySubscription, resolveQuota, listSubscriptions,
  cancelSubscriptionById, expireSubscriptions,
  parseModuleIds, listUserModules, revokeExpiredModuleGrants,
} from '../db.js';
import { MODULES } from '../modules/registry.js';
import { sendError, clamp } from '../lib/validate.js';

// 套餐展示：附带「包含哪些模块」——用户要能看清这个套餐买到的是哪几位「先生」的权限
function planView(p) {
  const ids = parseModuleIds(p.modules);
  return {
    id: p.id,
    name: p.name,
    description: p.description || '',
    price_cents: p.price_cents,
    period_days: p.period_days,
    daily_chat_limit: p.daily_chat_limit,
    credits: p.credits,
    modules: ids,
    modules_detail: ids.map((id) => {
      const m = MODULES.find((x) => x.id === id);
      return m ? { id, name: m.name, icon: m.icon, color: m.color } : { id, name: id, icon: 'sparkles', color: '#888' };
    }),
  };
}

// 我当前持有的模块权限（含来源与到期）——订阅面板与门户共用同一口径
function myModuleGrants(userId) {
  revokeExpiredModuleGrants(userId);
  const mine = listUserModules(userId);
  return MODULES.map((m) => {
    const g = mine[m.id];
    // 有记录以记录为准（撤销墓碑 = 无权限）；无记录才退回站点默认
    const has = g ? g.enabled : Boolean(m.defaultGrant);
    if (!has) return null;
    return {
      id: m.id,
      name: m.name,
      icon: m.icon,
      color: m.color,
      source: g?.granted_by ? (g.source || 'manual') : (m.defaultGrant ? 'default' : 'manual'),
      expires_at: g?.expires_at || null,
      granted_by: g?.granted_by || '',
    };
  }).filter(Boolean);
}

export default async function subscriptionRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get('/', auth, async (req) => {
    expireSubscriptions();
    const history = listSubscriptions({ userId: req.user.id, limit: 20 });
    return {
      plans: listPlans().map(planView),
      current: (() => {
        const cur = activeSubscription(req.user.id);
        if (!cur) return null;
        return { ...cur, modules: parseModuleIds(cur.modules) };
      })(),
      my_modules: myModuleGrants(req.user.id),
      pending: pendingSubscription(req.user.id),
      history,
      quota: resolveQuota(req.user.id),
      payment_enabled: false,
    };
  });

  fastify.post('/apply', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const planId = Number(req.body?.plan_id);
    if (!Number.isInteger(planId) || planId <= 0) return sendError(reply, 'bad_plan', '请选择要开通的套餐');
    const note = clamp(String(req.body?.note || '').trim(), 200);
    const r = applySubscription(req.user.id, planId, note);
    if (!r.ok) {
      if (r.code === 'no_plan') return sendError(reply, 'no_plan', '该套餐不存在或已下架', 404);
      if (r.code === 'pending_exists') return sendError(reply, 'pending_exists', '你已有一条待审批的申请，请等待管理员处理', 409);
      return sendError(reply, 'apply_failed', '申请失败，请稍后重试', 400);
    }
    return { ok: true, id: r.id, plan: planView(r.plan), pending: pendingSubscription(req.user.id) };
  });

  fastify.post('/cancel', auth, async (req, reply) => {
    const pending = pendingSubscription(req.user.id);
    if (!pending) return sendError(reply, 'no_pending', '当前没有待审批的申请', 404);
    cancelSubscriptionById(pending.id);
    return { ok: true, pending: null };
  });
}
