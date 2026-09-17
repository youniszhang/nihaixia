// Thin API client — all requests go same-origin to /api (proxied by Vite in dev,
// Caddy in prod). No API keys ever exist client-side.

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function parseError(res) {
  try {
    const data = await res.json();
    return data.message || `请求失败 (${res.status})`;
  } catch {
    return `请求失败 (${res.status})`;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = await parseError(res);
    throw new ApiError(msg, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // auth
  me: () => request('/api/auth/me'),
  authConfig: () => request('/api/auth/config'),
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  register: (username, password, inviteCode = '') => request('/api/auth/register', { method: 'POST', body: { username, password, invite_code: inviteCode } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  // profile
  getProfile: () => request('/api/profile'),
  saveProfile: (p) => request('/api/profile', { method: 'PUT', body: p }),

  // 每日签到 / 额度账户
  checkin: () => request('/api/checkin'),
  doCheckin: (cfToken = '') => request('/api/checkin', { method: 'POST', body: { cf_token: cfToken } }),

  // 订阅（套餐查看与申请）
  subscriptions: () => request('/api/subscription'),
  applySubscription: (planId, note = '') => request('/api/subscription/apply', { method: 'POST', body: { plan_id: planId, note } }),
  cancelSubscriptionRequest: () => request('/api/subscription/cancel', { method: 'POST' }),

  // admin
  getLlmConfig: () => request('/api/admin/llm'),
  saveLlmConfig: (p) => request('/api/admin/llm', { method: 'PUT', body: p }),
  openDswebLogin: () => request('/api/admin/dsweb/open-login', { method: 'POST' }),
  checkDswebLogin: () => request('/api/admin/dsweb/check-login'),
  killDswebBrowser: () => request('/api/admin/dsweb/kill-browser', { method: 'POST' }),
  injectDsToken: (token) => request('/api/admin/dsweb/inject-token', { method: 'POST', body: { token } }),
  clearDsToken: () => request('/api/admin/dsweb/clear-token', { method: 'POST' }),
  startInAppLogin: () => request('/api/admin/dsweb/in-app-login-start', { method: 'POST' }),
  inAppLoginStatus: () => request('/api/admin/dsweb/in-app-login-status'),

  // 系统更新（服务器一键部署）
  systemStatus: () => request('/api/system/status'),
  systemUpdate: () => request('/api/system/update', { method: 'POST' }),
  systemRestart: () => request('/api/system/restart', { method: 'POST' }),

  // 管理后台：概览 / 用户 / 对话记录 / 报表
  adminOverview: () => request('/api/admin/overview'),
  adminListUsers: () => request('/api/admin/users'),
  adminCreateUser: (username, password, note) => request('/api/admin/users', { method: 'POST', body: { username, password, note } }),
  adminUpdateUser: (id, patch) => request(`/api/admin/users/${id}`, { method: 'PATCH', body: patch }),
  adminDeleteUser: (id) => request(`/api/admin/users/${id}`, { method: 'DELETE' }),
  adminConversations: ({ userId, q, limit = 50, offset = 0 } = {}) => {
    const p = new URLSearchParams();
    if (userId) p.set('user_id', String(userId));
    if (q) p.set('q', q);
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    return request(`/api/admin/conversations?${p.toString()}`);
  },
  adminConversation: (id) => request(`/api/admin/conversations/${id}`),
  adminSearch: (q) => request(`/api/admin/search?q=${encodeURIComponent(q)}`),
  adminReports: (days = 14) => request(`/api/admin/reports?days=${days}`),
  adminBulkUsers: (ids, action) => request('/api/admin/users/bulk', { method: 'POST', body: { ids, action } }),
  adminGetSite: () => request('/api/admin/site'),
  adminSaveSite: (patch) => request('/api/admin/site', { method: 'PUT', body: patch }),
  adminAudit: (limit = 100) => request(`/api/admin/audit?limit=${limit}`),

  // 管理后台：邀请码
  adminInvites: () => request('/api/admin/invites'),
  adminCreateInvite: (payload) => request('/api/admin/invites', { method: 'POST', body: payload }),
  adminToggleInvite: (id, disabled) => request(`/api/admin/invites/${id}`, { method: 'PATCH', body: { disabled } }),
  adminDeleteInvite: (id) => request(`/api/admin/invites/${id}`, { method: 'DELETE' }),

  // 管理后台：套餐 / 订阅 / 签到报表 / 单用户额度明细
  adminPlans: () => request('/api/admin/plans'),
  adminCreatePlan: (plan) => request('/api/admin/plans', { method: 'POST', body: plan }),
  adminUpdatePlan: (id, patch) => request(`/api/admin/plans/${id}`, { method: 'PATCH', body: patch }),
  adminDeletePlan: (id) => request(`/api/admin/plans/${id}`, { method: 'DELETE' }),
  adminSubscriptions: ({ status, userId, limit = 200 } = {}) => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (userId) p.set('user_id', String(userId));
    p.set('limit', String(limit));
    return request(`/api/admin/subscriptions?${p.toString()}`);
  },
  adminApproveSubscription: (id) => request(`/api/admin/subscriptions/${id}/approve`, { method: 'POST' }),
  adminRejectSubscription: (id, reason = '') => request(`/api/admin/subscriptions/${id}/reject`, { method: 'POST', body: { reason } }),
  adminCancelSubscription: (id) => request(`/api/admin/subscriptions/${id}/cancel`, { method: 'POST' }),
  adminGrantSubscription: (userId, planId, note = '') => request(`/api/admin/users/${userId}/subscribe`, { method: 'POST', body: { plan_id: planId, note } }),
  adminUserQuota: (id) => request(`/api/admin/users/${id}/quota`),
  adminCheckins: (days = 14) => request(`/api/admin/checkins?days=${days}`),

  // sessions
  listSessions: () => request('/api/sessions'),
  createSession: (title) => request('/api/sessions', { method: 'POST', body: { title } }),
  // 历史会话按页拉取（长会话全量返回会明显变慢）；beforeId 用于向上翻页
  getSession: (id, { limit = 60, beforeId = null } = {}) => {
    const p = new URLSearchParams();
    p.set('limit', String(limit));
    if (beforeId) p.set('before_id', String(beforeId));
    return request(`/api/sessions/${id}?${p.toString()}`);
  },
  renameSession: (id, title) => request(`/api/sessions/${id}`, { method: 'PATCH', body: { title } }),
  setSessionPin: (id, pin) => request(`/api/sessions/${id}`, { method: 'PATCH', body: { pin } }),
  deleteSession: (id) => request(`/api/sessions/${id}`, { method: 'DELETE' }),

  // chat streaming: returns an async generator of SSE events
  streamChat: async function* (sessionId, content, signal, pin = '') {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, content, pin }),
      signal,
    });
    if (!res.ok) throw new ApiError(await parseError(res), res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            yield JSON.parse(line.slice(5));
          } catch { /* ignore malformed */ }
        }
      }
    }
  },
};

// 展示层用的流式错误（notice 提示 / error 终止）
export const streamEventNames = ['delta', 'notice', 'error', 'done'];
