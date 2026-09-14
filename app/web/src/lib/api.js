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
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  register: (username, password) => request('/api/auth/register', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  // profile
  getProfile: () => request('/api/profile'),
  saveProfile: (p) => request('/api/profile', { method: 'PUT', body: p }),

  // admin
  getLlmConfig: () => request('/api/admin/llm'),
  saveLlmConfig: (p) => request('/api/admin/llm', { method: 'PUT', body: p }),
  openDswebLogin: () => request('/api/admin/dsweb/open-login', { method: 'POST' }),
  checkDswebLogin: () => request('/api/admin/dsweb/check-login'),
  killDswebBrowser: () => request('/api/admin/dsweb/kill-browser', { method: 'POST' }),
  injectDsToken: (token) => request('/api/admin/dsweb/inject-token', { method: 'POST', body: { token } }),
  startInAppLogin: () => request('/api/admin/dsweb/in-app-login-start', { method: 'POST' }),
  inAppLoginStatus: () => request('/api/admin/dsweb/in-app-login-status'),
  lanInfo: () => request('/api/lan-info'),

  // sessions
  listSessions: () => request('/api/sessions'),
  createSession: (title) => request('/api/sessions', { method: 'POST', body: { title } }),
  getSession: (id) => request(`/api/sessions/${id}`),
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
