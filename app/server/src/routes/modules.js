// 玄枢 · 用户侧模块 API
//   GET  /api/modules          → 模块列表（含当前用户开通状态 + 站点开关 + 权限原因）
//   POST /api/modules/authorize → 用户申请开通某模块（写入申请，管理员审批）
//
// 权限模型：
//   站点开关（module_enabled_<id>）= 模块整体上下线，管理员在后台控制；
//   用户开通（user_modules 表）    = 逐用户发牌，来源分两类：
//        manual = 管理员手动开通（永久，除非管理员撤销）
//        plan   = 订阅套餐附带（到期自动失效）
//   管理员：站点开启的模块默认可用（自用不发牌）。
//
// 门户展示策略（2026-09-18）：**所有模块都返回**，前端全部渲染成卡片；
// 无权限的卡片灰化并显示「无权限」+ 申请/订阅入口，而不是把卡片藏起来。

import { MODULES } from '../modules/registry.js';
import {
  getModuleSiteEnabled, listUserModules, userHasModule, getUserModuleGrant,
  grantUserModule, getSetting, setSetting, revokeExpiredModuleGrants,
  listPlans, parseModuleIds,
} from '../db.js';
import { redact } from '../lib/redact.js';
import { sendError, clamp } from '../lib/validate.js';

// 用户可用但不该出现的内部字段统一在这里裁剪
function publicModule(m, ctx) {
  const { isAdmin, mine, activePlans } = ctx;
  const siteEnabled = getModuleSiteEnabled(m.id);
  const grant = mine[m.id] || null;
  const byDefault = Boolean(m.defaultGrant);
  // 有记录（含撤销墓碑）以记录为准；从未发过牌的老账号才吃 defaultGrant 兜底
  const granted = grant ? Boolean(grant.enabled) : byDefault;
  const available = isAdmin ? true : (siteEnabled && granted);

  // 无权限时给出原因，前端据此决定卡片上的按钮/文案
  let lockReason = '';
  if (!available && !isAdmin) {
    if (!siteEnabled) lockReason = 'offline';       // 站点未上线：连申请都不该有
    else if (!granted) lockReason = 'no_grant';     // 站点在售/可用，但该用户没权限
  }
  // 可订阅性：是否有生效中的套餐包含这个模块
  const planNames = activePlans.filter((p) => (p.modules || []).includes(m.id)).map((p) => p.name);

  return {
    id: m.id,
    name: m.name,
    tagline: m.tagline,
    icon: m.icon,
    color: m.color,
    tool_name: m.toolName,
    has_tool: Boolean(m.tools.length),
    default_grant: byDefault,
    // 展示文案（静态、非敏感）
    disclaimer: m.disclaimer,
    empty_quote: m.emptyQuote,
    suggestions: m.suggestions,
    placeholder: m.placeholder,
    empty_hint: m.emptyHint,
    site_enabled: siteEnabled,
    granted,
    available,
    lock_reason: lockReason,
    // 管理员专用视角标记：站点未上线但管理员可进
    admin_preview: isAdmin && !siteEnabled,
    // 权限来源（前端展示「订阅至 X」「管理员开通」）
    grant_source: grant?.granted_by
      ? (grant.source || 'manual')
      : (byDefault ? 'default' : ''),
    grant_expires_at: grant?.expires_at || null,
    // 开通方式与入口
    open_mode: getSetting(`module_open_mode_${m.id}`) || 'apply',
    // 含此模块的生效套餐名（供「去订阅」提示）
    plans_with_module: planNames,
  };
}

export default async function moduleRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] };

  // 模块目录 + 我的开通状态（**返回全部模块**，前端全渲染卡片）
  fastify.get('/', auth, async (req) => {
    revokeExpiredModuleGrants(req.user.id); // 订阅到期即回收，保证展示与判定一致
    const isAdmin = Boolean(req.user.is_admin);
    const mine = listUserModules(req.user.id);
    // 在售套餐（用于「哪些套餐含此模块」的引导提示，而不是只提示当前订阅）
    const sellablePlans = listPlans().map((p) => ({ id: p.id, name: p.name, modules: parseModuleIds(p.modules) }));
    const ctx = { isAdmin, mine, activePlans: sellablePlans };
    return { modules: MODULES.map((m) => publicModule(m, ctx)) };
  });

  // 申请开通：open_mode=auto 时立即生效；apply 时写一条待审批申请
  fastify.post('/authorize', auth, async (req, reply) => {
    const moduleId = clamp(String(req.body?.module_id || '').trim(), 20);
    const note = clamp(String(req.body?.note || '').trim(), 200);
    const mod = MODULES.find((m) => m.id === moduleId);
    if (!mod) return sendError(reply, 'bad_module', '未知模块', 404);
    if (!getModuleSiteEnabled(moduleId)) {
      return sendError(reply, 'module_offline', `「${mod.name}」暂未上线，敬请期待。`, 400);
    }
    if (userHasModule(req.user, moduleId) || mod.defaultGrant) {
      return { ok: true, granted: true, message: '该模块已开通' };
    }
    const mode = getSetting(`module_open_mode_${moduleId}`) || 'apply';
    if (mode === 'auto') {
      grantUserModule(req.user.id, moduleId, 'auto');
      return { ok: true, granted: true, message: `「${mod.name}」已开通` };
    }
    // apply：挂到 settings 里的申请列表（管理员后台审批用）
    const requests = listModuleRequests();
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    requests.unshift({
      id, user_id: req.user.id, username: req.user.username,
      module_id: moduleId, note: redact(note).slice(0, 200), created_at: new Date().toISOString(),
      status: 'pending',
    });
    setSetting('module_requests', JSON.stringify(requests.slice(0, 500)));
    return { ok: true, granted: false, message: `已提交「${mod.name}」开通申请，请等待管理员审核。` };
  });
}

// —— 申请列表（settings JSON 数组；管理员审批用） ——
export function listModuleRequests() {
  try { return JSON.parse(getSetting('module_requests') || '[]'); } catch { return []; }
}