// 玄枢 · 用户侧模块 API
//   GET  /api/modules          → 模块列表（含当前用户开通状态 + 站点开关）
//   POST /api/modules/authorize → 用户申请开通某模块（写入申请，管理员审批）
//
// 权限模型：
//   站点开关（module_enabled_<id>）= 模块整体上下线，管理员在后台控制；
//   用户开通（user_modules 表）    = 逐用户发牌，管理员在后台逐个/批量开通；
//   管理员：站点开启的模块默认可用（自用不发牌）。

import { MODULES } from '../modules/registry.js';
import {
  getModuleSiteEnabled, listUserModules, userHasModule,
  grantUserModule, getSetting, setSetting, deleteSetting,
} from '../db.js';
import { sendError, clamp } from '../lib/validate.js';

export default async function moduleRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] };

  // 模块目录 + 我的开通状态
  // 视角规则（对齐 sub2api 的「管理员是普通用户的超集」）：
  //   管理员 → 所有模块一律 available（含未上线的），仅用 site_enabled 标注站点状态；
  //   普通用户 → 站点上线 && 已开通（defaultGrant 模块站点上线即可用）。
  fastify.get('/', auth, async (req) => {
    const mine = listUserModules(req.user.id);
    const isAdmin = Boolean(req.user.is_admin);
    const modules = MODULES.map((m) => {
      const siteEnabled = getModuleSiteEnabled(m.id);
      const granted = Boolean(mine[m.id]?.enabled) || Boolean(m.defaultGrant);
      const available = isAdmin ? true : (siteEnabled && granted);
      return {
        id: m.id,
        name: m.name,
        tagline: m.tagline,
        icon: m.icon,
        color: m.color,
        tool_name: m.toolName,
        has_tool: Boolean(m.tools.length),
        default_grant: Boolean(m.defaultGrant),
        // 展示文案（静态、非敏感；聊天界面直接使用）
        disclaimer: m.disclaimer,
        empty_quote: m.emptyQuote,
        suggestions: m.suggestions,
        placeholder: m.placeholder,
        empty_hint: m.emptyHint,
        site_enabled: siteEnabled,
        granted,
        available,
        // 管理员专用视角标记：前端据此显示「未上线 · 仅管理员可见」
        admin_preview: isAdmin && !siteEnabled,
        // 待开通申请设置（站点设置 module_open_mode_<id>: 'apply' | 'auto'，默认 apply）
        open_mode: getSetting(`module_open_mode_${m.id}`) || 'apply',
      };
    });
    return { modules };
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
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;    requests.unshift({
      id, user_id: req.user.id, username: req.user.username,
      module_id: moduleId, note, created_at: new Date().toISOString(),
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
