// 出口脱敏：任何要回传给客户端（浏览器/桌面/用户对话窗口）的错误文本，
// 一律先过 redact()，把可能夹带的凭据抹掉。
//
// 为什么需要（2026-09-18 实测复现）：
//   OpenAI 兼容中转 / WAF / 部分网关在报错时会把请求头原样回显，
//   上游 500 的响应体里带着 `{"request_headers":{"authorization":"Bearer sk-..."}}`，
//   而 chat 路由把上游 body 拼进 SSE 错误消息 → 普通用户在对话窗口里就能读到 API Key。
//   这里做最后一道兜底：即便某条路径忘了收口，密钥也出不去。

const RULES = [
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ***'],
  // OpenAI 风格密钥
  [/\bsk-[A-Za-z0-9._-]{4,}/gi, 'sk-***'],
  // JWT / DeepSeek userToken 等以 eyJ 开头的 base64url 串
  [/\beyJ[A-Za-z0-9._-]{12,}/g, '***JWT***'],
  // JSON / JS 里的 key-value 形式： "api_key":"xxx" / token=xxx / password: xxx
  [/(["']?(?:api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|user[_-]?token|token|secret|password|passwd|cookie)["']?\s*[:=]\s*["']?)([^"'\s,;&}\]]{4,})/gi, '$1***'],
  // 超长十六进制串（APP_SECRET / INTERNAL_TOKEN 这类随机串）
  [/\b[0-9a-f]{32,}\b/gi, '***HEX***'],
  // 超长 base64（>=40 字符，常见于各类 token）
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '***TOKEN***'],
];

export function redact(input) {
  if (input == null) return '';
  let s = typeof input === 'string' ? input : String(input);
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s;
}

// 给用户看的错误短号：便于管理员拿着编号去服务端日志里查完整原因
export function errorRef() {
  return Math.random().toString(36).slice(2, 10);
}
