import { getSession, addMessage, touchSession, countMessages, renameSession, getProfile, listRecentMessages, updateSessionPin, getSetting, logUsage, usageCountToday } from '../db.js';
import { sendError, clamp } from '../lib/validate.js';
import { retrieve } from '../knowledge/loader.js';
import { SYSTEM_PROMPT, buildRagBlock } from '../knowledge/system-prompt.js';
import { streamChat } from '../llm.js';
import { connectDeepSeek, askStream, killBrowser, findBrowserBinary } from '../lib/dsweb.js';
import { askDirect } from '../lib/dsapi.js';
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

    // 每日问诊上限（每用户，按当日成功生成计数；站点设置 daily_chat_limit，0 = 不限）
    const dailyLimit = Number(getSetting('daily_chat_limit') || 0);
    if (dailyLimit > 0 && usageCountToday(req.user.id) >= dailyLimit) {
      return sendError(reply, 'daily_limit', `今日问诊次数已达上限（每天 ${dailyLimit} 次），请明天再来，或联系管理员在「站点设置」调整。`, 429);
    }

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
    // 注意：必须取「最近」N 条。旧的 listMessages 是 ASC+LIMIT，
    // 长会话下返回最早的消息，本轮提问反而进不了上下文。
    const history = [];
    const rows = listRecentMessages(sessionId, 30);
    for (const r of rows) {
      if (r.role === 'system') continue;
      if (r.id === userMsgId) continue; // 本轮提问稍后单独拼，避免重复
      history.push({ role: r.role, content: r.content });
    }

    const profile = getProfile(req.user.id);
    const provider = getSetting('llm_provider') === 'dsweb' ? 'dsweb' : 'api';

    const chunks = retrieve(content + '\n' + activePin, 8);
    const sysContent = SYSTEM_PROMPT
      + (activePin ? '\n\n【本次问诊固定背景（十问/舌象等摘录）】\n' + activePin : '')
      + profileBlock(profile)
      + '\n\n' + buildRagBlock(chunks);

    // —— system 消息的两种下法 ——
    // 部分 OpenAI 兼容中转（如 aitrybest）会丢弃 system 角色，模型只看到裸提问，
    // 表现为「倪师人设失效、被当成编程助手」。此时把人设并入本轮用户消息。
    // auto：官方 api.deepseek.com 用 system，其它中转一律 inline（实测最稳）。
    const baseUrlForMode = getSetting('llm_base_url') || config.llm.baseUrl;
    const modeSetting = getSetting('llm_system_mode') || 'auto';
    const isOfficialDeepSeek = /^https?:\/\/([^/]*\.)?api\.deepseek\.com(\/|$)/i.test(baseUrlForMode);
    const useSystemRole = modeSetting === 'system' || (modeSetting === 'auto' && isOfficialDeepSeek);

    const messages = useSystemRole
      ? [
          { role: 'system', content: sysContent },
          ...history,
          { role: 'user', content },
        ]
      : [
          ...history,
          { role: 'user', content: sysContent + '\n\n【病人发言】\n' + content },
        ];

    let full = '';
    try {
      sse(reply, { type: 'start', user_msg_id: userMsgId });
      if (provider === 'dsweb') {
        // —— 网页版 DeepSeek（0 Token）：把系统指令与问诊上下文并入单条网页消息 ——
        const dsPort = Number(getSetting('dsweb_port') || 9223);
        const dsExpert = getSetting('dsweb_expert') !== 'false';
        const compactRag = chunks.length
          ? chunks.map((c, i) => `〔摘录${i + 1}〕${(c.content || '').slice(0, 400)}`).join('\n')
          : '';
        const webPrompt = [
          '【角色设定】' + SYSTEM_PROMPT.split('【输出格式')[0].slice(0, 1200),
          activePin ? '【问诊背景】\n' + activePin : '',
          profileBlock(profile),
          compactRag ? '【知识库摘录（回答时参考，禁止照抄）】\n' + compactRag : '',
          '【病人发言】\n' + content,
        ].filter(Boolean).join('\n\n');

        // 优先走「直连通道」：用管理员配置的登录凭证直接调网页版接口（无需浏览器，
        // 服务器部署也能用）。未配置凭证时回退到浏览器自动化通道。
        const dsToken = getSetting('dsweb_user_token') || process.env.DSWEB_USER_TOKEN;
        if (dsToken) {
          try {
            for await (const ev of askDirect(dsToken, { prompt: webPrompt, expertMode: dsExpert })) {
              if (ev.type === 'delta') { full += ev.text; sse(reply, { type: 'delta', text: ev.text }); }
              else if (ev.type === 'done') break;
            }
          } catch (directErr) {
            fastify.log.warn({ err: String(directErr) }, 'dsweb direct channel failed');
            if (!findBrowserBinary()) {
              const e = new Error(
                '网页版直连失败：' + (directErr.message || String(directErr)).slice(0, 140)
                + '（若是凭证过期，请在管理后台「模型设置 → 粘贴登录凭证」重新导入）'
              );
              e.code = 'dsweb_direct';
              throw e;
            }
            // 本机有浏览器（桌面版）：回退浏览器通道，尽量把答案给到用户
            sse(reply, { type: 'notice', text: '直连通道异常，改用浏览器通道重试…' });
            const client = await connectDeepSeek(dsPort, false);
            try {
              for await (const ev of askStream(client, { prompt: webPrompt, expertMode: dsExpert })) {
                if (ev.type === 'delta') { full += ev.text; sse(reply, { type: 'delta', text: ev.text }); }
                else if (ev.type === 'done') break;
              }
            } finally {
              client.close();
            }
          }
        } else {
          const runOnce = async function* () {
          const client = await connectDeepSeek(dsPort, false);
          try {
            for await (const ev of askStream(client, { prompt: webPrompt, expertMode: dsExpert })) {
              yield ev;
            }
          } finally {
            client.close();
          }
        };
        try {
          for await (const ev of runOnce()) {
            if (ev.type === 'delta') { full += ev.text; sse(reply, { type: 'delta', text: ev.text }); }
            else if (ev.type === 'done') break;
          }
        } catch (firstErr) {
          // 首次失败：杀掉可能僵死的专用浏览器后重试一次；已流出的内容不重复
          fastify.log.warn({ err: String(firstErr) }, 'dsweb first attempt failed, retrying with fresh browser');
          sse(reply, { type: 'notice', text: '网页版通道异常，正在自动重启浏览器重试…' });
          try { killBrowser(); } catch {}
          await new Promise((r) => setTimeout(r, 1500));
          for await (const ev of runOnce()) {
            if (ev.type === 'delta') { full += ev.text; sse(reply, { type: 'delta', text: ev.text }); }
            else if (ev.type === 'done') break;
          }
          }
        }
      } else {
        // —— API 模式（OpenAI 兼容）。Admin panel settings (DB) take priority over .env ——
        const llmCfg = {
          apiKey: getSetting('llm_api_key') || config.llm.apiKey,
          baseUrl: getSetting('llm_base_url') || config.llm.baseUrl,
          model: getSetting('llm_model') || config.llm.model,
        };
        for await (const delta of streamChat(messages, abortController.signal, llmCfg)) {
          full += delta;
          sse(reply, { type: 'delta', text: delta });
        }
      }
      if (full.trim()) {
        const asstId = addMessage(sessionId, 'assistant', full);
        touchSession(sessionId);
        // 用量报表：记录本次成功调用（字符数即用量规模的可靠代理指标）
        try {
          logUsage({
            userId: req.user.id,
            sessionId,
            provider,
            model: provider === 'dsweb' ? 'deepseek-web' : (getSetting('llm_model') || config.llm.model),
            promptChars: sysContent.length + content.length,
            completionChars: full.length,
          });
        } catch { /* 统计失败不影响对话 */ }
        sse(reply, { type: 'done', message_id: asstId });
      } else {
        sse(reply, { type: 'error', message: '本次未收到有效回复，请重试。' });
      }
    } catch (err) {
      fastify.log.warn({ err: String(err) }, 'chat generation failed');
      const msg =
        provider === 'dsweb' ? (
          // 直连通道的失败原因要原样带给用户/管理员，否则只能翻服务器日志
          '网页版 DeepSeek 调用失败：' + (err.message || String(err)).slice(0, 200)
          + (/凭证|token|登录|未授权|401|403/i.test(String(err))
            ? '（登录凭证可能已失效，请在管理后台「模型设置 → 粘贴登录凭证」重新导入）'
            : '（管理员可在管理后台「模型设置」检查接入配置）')
        )
        : err.code === 'no_api_key' ? '未配置模型：请管理员在「模型设置」中填写 API Key，或切换到网页版 DeepSeek（0 Token）模式。'
        : err.code === 'auth' ? '模型服务鉴权失败（API Key 无效）。'
        : err.code === 'rate_limit' ? '模型服务繁忙，请稍后重试。'
        : err.code === 'network' ? `无法连接模型服务：${(err.message || '').slice(0, 150)}`
        : err.code === 'upstream' ? `模型服务返回错误：${(err.detail || err.message || '').slice(0, 150)}`
        : '模型服务暂不可用，请稍后再试。';
      // Keep the partial answer if any
      if (full) {
        const asstId = addMessage(sessionId, 'assistant', full + `\n\n〔生成中断：${msg}〕`);
        try {
          logUsage({
            userId: req.user.id,
            sessionId,
            provider,
            model: provider === 'dsweb' ? 'deepseek-web' : (getSetting('llm_model') || config.llm.model),
            promptChars: sysContent.length + content.length,
            completionChars: full.length,
          });
        } catch { /* ignore */ }
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
