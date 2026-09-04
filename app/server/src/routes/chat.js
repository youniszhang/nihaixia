import { getSession, addMessage, touchSession, countMessages, renameSession, getProfile, listMessages, updateSessionPin, getSetting } from '../db.js';
import { sendError, clamp } from '../lib/validate.js';
import { retrieve } from '../knowledge/loader.js';
import { SYSTEM_PROMPT, buildRagBlock } from '../knowledge/system-prompt.js';
import { streamChat } from '../llm.js';
import config from '../config.js';

function sse(res, data) {
  res.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function profileBlock(p) {
  if (!p) return '';
  const lines = [];
  if (p.nickname) lines.push(`称呼：${p.nickname}`);
  if (p.gender) lines.push(`性别：${p.gender}`);
  if (p.age) lines.push(`年龄：${p.age} 岁`);
  if (p.height_cm) lines.push(`身高：${p.height_cm} cm`);
  if (p.weight_kg) lines.push(`体重：${p.weight_kg} kg`);
  if (p.body_notes) lines.push(`体征备注：${p.body_notes}`);
  if (!lines.length) return '';
  return '\n\n【病人体质档案】\n' + lines.join('\n');
}

export default async function chatRoutes(fastify) {
  // Per-user rate limit on chat starts
  const rateOpts = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  fastify.post('/send', { preHandler: [fastify.authenticate], ...rateOpts }, async (req, reply) => {
    const sessionId = req.body?.session_id;
    const content = clamp((req.body?.content || '').trim(), 4000);
    const pin = clamp((req.body?.pin || '').trim(), 2000);
    if (!sessionId || !content) return sendError(reply, 'bad_request', '缺少 session_id 或消息内容');

    const session = getSession(sessionId);
    if (!session || session.user_id !== req.user.id) return sendError(reply, 'not_found', '问诊会话不存在', 404);

    // Persist an updated intake pin (十问/舌象) if the client sent one
    const activePin = pin || session.pin || '';
    if (pin && pin !== session.pin) {
      updateSessionPin(sessionId, pin);
    }

    // Keep a transient user message; it is persisted only when generation starts
    // (avoids orphan rows on client abort mid-request setup).
    const userMsgId = addMessage(sessionId, 'user', content);

    // Auto-title from first user question
    if (countMessages(sessionId) <= 1) {
      const title = content.replace(/\s+/g, ' ').slice(0, 16);
      renameSession(sessionId, title || '新问诊');
    }

    // Prepare SSE
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    const abortController = new AbortController();
    req.raw.on('close', () => { clearInterval(heartbeat); abortController.abort(); });

    // Build conversation
    const history = [];
    const rows = listMessages(sessionId, 30);
    for (const r of rows) {
      if (r.role === 'system') continue;
      history.push({ role: r.role, content: r.content });
    }

    const profile = getProfile(req.user.id);
    const chunks = retrieve(content + '\n' + activePin, 8);
    const sysContent = SYSTEM_PROMPT
      + (activePin ? '\n\n【本次问诊固定背景（十问/舌象等摘录）】\n' + activePin : '')
      + profileBlock(profile)
      + '\n\n' + buildRagBlock(chunks);

    const messages = [
      { role: 'system', content: sysContent },
      ...history,
    ];

    let full = '';
    try {
      sse(reply, { type: 'start', user_msg_id: userMsgId });
      // Admin panel settings (DB) take priority over .env defaults
      const llmCfg = {
        apiKey: getSetting('llm_api_key') || config.llm.apiKey,
        baseUrl: getSetting('llm_base_url') || config.llm.baseUrl,
        model: getSetting('llm_model') || config.llm.model,
      };
      for await (const delta of streamChat(messages, abortController.signal, llmCfg)) {
        full += delta;
        sse(reply, { type: 'delta', text: delta });
      }
      const asstId = addMessage(sessionId, 'assistant', full);
      touchSession(sessionId);
      sse(reply, { type: 'done', message_id: asstId });
    } catch (err) {
      fastify.log.warn({ err: String(err) }, 'chat generation failed');
      const msg =
        err.code === 'no_api_key' ? '服务器未配置 LLM_API_KEY，请联系管理员。'
        : err.code === 'auth' ? '模型服务鉴权失败（API Key 无效）。'
        : err.code === 'rate_limit' ? '模型服务繁忙，请稍后重试。'
        : '模型服务暂不可用，请稍后再试。';
      // Keep the partial answer if any
      if (full) {
        const asstId = addMessage(sessionId, 'assistant', full + `\n\n〔生成中断：${msg}〕`);
        sse(reply, { type: 'done', message_id: asstId });
      } else {
        sse(reply, { type: 'error', message: msg });
      }
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
  });
}
