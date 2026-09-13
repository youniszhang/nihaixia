import config from './config.js';

// cfg: optional { apiKey, baseUrl, model } override (admin panel settings).
// Falls back to env config.
export async function* streamChat(messages, signal, cfg) {
  const llm = cfg && cfg.apiKey ? cfg : config.llm;
  const key = llm.apiKey;
  if (!key) {
    const e = new Error('LLM_API_KEY 未配置，请管理员在「模型设置」中填写，或联系管理员');
    e.code = 'no_api_key';
    throw e;
  }
  // baseUrl 规范化：已带 /v1（或 /v2 等）的地址直接拼 /chat/completions，
  // 否则补 /v1 前缀（兼容 https://api.deepseek.com 与 https://xxx/v1 两种写法）
  const base = llm.baseUrl.replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), config.llm.timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages,
        stream: true,
        temperature: 0.7,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error('无法连接到模型服务：' + (err.cause?.message || err.message));
    e.code = 'network';
    throw e;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const body = await res.text().catch(() => '');
    const e = new Error(`模型服务返回错误 (${res.status})`);
    e.code = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : 'upstream';
    e.detail = body.slice(0, 300);
    throw e;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch { /* partial JSON across chunks is fine */ }
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}
