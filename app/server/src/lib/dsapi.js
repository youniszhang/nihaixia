/**
 * DeepSeek 网页版「直连」通道 —— 用 userToken + PoW 直接调用网页版内部接口，
 * 不需要任何浏览器（浏览器通道见 dsweb.js，桌面版仍可选用）。
 *
 * 已验证事实（2026-09）：
 *   - 认证只需 authorization: Bearer <userToken>（localStorage 里 {"value":"..."} 的值）
 *   - /api/v0/chat/completion 额外要求 x-ds-pow-response（PoW，见 dspow.js）
 *   - 网页端的 x-hif-* 反自动化头【不是必需】（实测缺失时不影响鉴权判定）
 *   - 流式响应格式与浏览器通道相同（JSON-Patch），复用 parseDSWebSSE 解析
 */

import { parseDSWebSSE } from './dsweb.js';
import { powHeaderFor } from './dspow.js';

const BASE = 'https://chat.deepseek.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

function baseHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'user-agent': UA,
    accept: '*/*',
    origin: BASE,
    referer: `${BASE}/`,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'x-client-version': '2.5.0',
  };
}

/** 校验 token 是否有效（顺带拿到账号信息） */
export async function verifyToken(token) {
  if (!token) return { ok: false, reason: '未填写凭证' };
  try {
    const res = await fetch(`${BASE}/api/v0/users/current`, {
      headers: baseHeaders(token),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    if (j?.data?.biz_code === 0) {
      const info = j.data.biz_data || {};
      return { ok: true, email: info.email || '', mobile: info.mobile || '' };
    }
    return { ok: false, reason: j?.msg || j?.data?.biz_msg || '凭证无效或已过期' };
  } catch (err) {
    return { ok: false, reason: `网络错误：${(err.message || err).slice(0, 120)}` };
  }
}

/** 新建一个网页版对话会话，返回 session id */
async function createSession(token) {
  const res = await fetch(`${BASE}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: { ...baseHeaders(token), 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  const id = j?.data?.biz_data?.id || j?.data?.biz_data?.chat_session?.id;
  if (!id) throw new Error(`创建会话失败：${j?.msg || j?.data?.biz_msg || '未知错误'}`);
  return id;
}

/**
 * 发起一次直连提问，流式产出增量文本。
 * yields { type: 'delta'|'done', text }
 */
export async function* askDirect(token, { prompt, expertMode = true, timeoutMs = 240000 }) {
  const sessionId = await createSession(token);
  const pow = await powHeaderFor(token, '/api/v0/chat/completion');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('直连请求超时')), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}/api/v0/chat/completion`, {
      method: 'POST',
      headers: {
        ...baseHeaders(token),
        'content-type': 'application/json',
        'x-ds-pow-response': pow,
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: null,
        prompt,
        ref_file_ids: [],
        thinking_enabled: !!expertMode,
        search_enabled: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`直连请求失败：${(err.message || err).slice(0, 160)}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const body = await res.text().catch(() => '');
    throw new Error(`网页版接口返回 HTTP ${res.status}：${body.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';      // 累积的原始 SSE 文本（与浏览器通道读取的 window.__aieSSE 等价）
  let sentLen = 0;
  let finished = false;
  let idleTicks = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });

      // 业务错误（非流式错误体）
      if (raw.length < 400 && /"code":(?!0)\d+/.test(raw) && !raw.includes('"p":')) {
        try {
          const errJson = JSON.parse(raw);
          if (errJson?.code && errJson.code !== 0) {
            throw new Error(`网页版接口错误 ${errJson.code}：${errJson.msg || ''}`);
          }
        } catch (e) {
          if (String(e).includes('网页版接口错误')) throw e;
        }
      }

      const parsed = parseDSWebSSE(raw);
      if (parsed.content && parsed.content.length > sentLen) {
        yield { type: 'delta', text: parsed.content.slice(sentLen) };
        sentLen = parsed.content.length;
        idleTicks = 0;
      } else {
        idleTicks++;
      }
      if (parsed.finished) { finished = true; break; }
      // 长时间无新增且流未结束：交给外层超时控制
      if (idleTicks > 200) break;
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }

  if (!finished && sentLen === 0) {
    // 带上服务端实际收到的响应头片段，否则「空流」无法定位（IP 风控 / 错误码 / 接口变更难以区分）
    let detail = '';
    const cm = raw.match(/"code":(\d+)/);
    if (cm && cm[1] !== '0') {
      const mm = raw.match(/"msg":"([^"]{0,80})"/);
      detail = `：网页版接口错误 ${cm[1]}${mm ? ` ${mm[1]}` : ''}`;
    } else if (raw.trim()) {
      detail = `（响应片段：${raw.replace(/\s+/g, ' ').trim().slice(0, 120)}）`;
    } else {
      detail = '（响应为空流，服务器 IP 可能被网页版风控拦截）';
    }
    throw new Error(`直连通道未收到任何回复内容${detail}`);
  }
  yield { type: 'done' };
}
