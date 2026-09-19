import { getSession, addMessage, touchSession, countMessages, renameSession, getProfile, listRecentMessages, updateSessionPin, getSetting, logUsage, usageCountToday, resolveQuota, consumeCredit, userHasModule } from '../db.js';
import { sendError, clamp } from '../lib/validate.js';
import { redact, errorRef } from '../lib/redact.js';
import { retrieve, retrieveForModule } from '../knowledge/loader.js';
import { buildRagBlock } from '../knowledge/system-prompt.js';
import { MODULE_PROMPTS } from '../modules/prompts.js';
import { getModule, detectBoostDirs } from '../modules/registry.js';
import { baziPaiPan, tarotDraw, qimenPaiPan } from '../modules/tools.js';
import { streamChat } from '../llm.js';
import { acquireGenerationSlot, release as releaseCapacity, capacityStats } from '../lib/capacity.js';
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
  return '\n\n【用户体质档案（问诊参考）】\n' + lines.join('\n');
}

// 模块会话的固定背景块：中医沿用「问诊单」语义，其余模块统称「咨询背景」
function pinLabel(moduleId) {
  return moduleId === 'tcm' ? '问诊' : '咨询';
}

// —— 工具执行：识别消息中的排盘/抽牌请求并跑脚本 ——
// 返回 { ran: bool, label: string, output: string }
async function runModuleTool(moduleId, content, getSettingFn) {
  const mod = getModule(moduleId);
  if (!mod || !mod.tools.length) return null;

  if (moduleId === 'bazi') {
    // 模型/用户以【排盘请求】标记触发；参数由上一轮模型给出的 JSON 携带
    const m = content.match(/【排盘请求】\s*```json\s*([\s\S]*?)```/);
    if (!m) return null;
    try {
      const args = JSON.parse(m[1].trim());
      const out = await baziPaiPan(args);
      return { ran: true, label: '四柱排盘脚本输出', output: out };
    } catch (e) {
      return { ran: true, label: '排盘脚本错误', output: String(e.message || e) };
    }
  }

  if (moduleId === 'qimen') {
    const m = content.match(/【起局请求】\s*```json\s*([\s\S]*?)```/);
    if (!m) return null;
    try {
      const args = JSON.parse(m[1].trim());
      const out = await qimenPaiPan(args);
      return { ran: true, label: '奇门排盘脚本输出（mainline-cn-v1）', output: typeof out === 'string' ? out : JSON.stringify(out, null, 1).slice(0, 18000) };
    } catch (e) {
      return { ran: true, label: '起局脚本错误', output: String(e.message || e) };
    }
  }

  if (moduleId === 'tarot') {
    const m = content.match(/【抽牌请求】\s*```json\s*([\s\S]*?)```/);
    if (!m) return null;
    try {
      const args = JSON.parse(m[1].trim());
      const out = await tarotDraw(args);
      return { ran: true, label: '抽牌脚本输出（含 seed/time_factor，解读时必须原样展示）', output: JSON.stringify(out, null, 1) };
    } catch (e) {
      return { ran: true, label: '抽牌脚本错误', output: String(e.message || e) };
    }
  }

  return null;
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

    // 模块归属与开通校验：会话创建时已绑定模块；老会话（module 为空）视为中医
    const moduleId = session.module || 'tcm';
    const mod = getModule(moduleId);
    if (!mod) return sendError(reply, 'bad_module', '该会话所属模块不存在', 400);
    if (!userHasModule(req.user, moduleId)) {
      return sendError(reply, 'module_locked', `「${mod.name}」模块未开通或已下线，请联系管理员开通。`, 403);
    }

    // 额度（每用户，全模块共用同一套额度/每日上限）：
    const quota = resolveQuota(req.user.id);
    if (!quota.unlimited && quota.credits <= 0) {
      return sendError(reply, 'no_credits', '额度已用完。可在「每日签到」中领取额度，或开通订阅套餐后继续。', 402);
    }
    if (quota.daily_limit > 0 && quota.used_today >= quota.daily_limit) {
      const src = quota.daily_limit_source === 'user' ? '（管理员为该账号设置）'
        : quota.daily_limit_source === 'plan' ? `（当前套餐「${quota.subscription?.plan_name || ''}」）`
        : '（站点默认）';
      return sendError(reply, 'daily_limit', `今日使用次数已达上限（每天 ${quota.daily_limit} 次）${src}，请明天再来。`, 429);
    }

    // 扣额度：与 usage_log 同点发生，保证「计数」与「扣费」不会各算各的
    const chargeCredit = (note) => {
      try { consumeCredit(req.user.id, note); } catch { /* 记账失败不影响对话 */ }
    };
    const quotaSnapshot = () => {
      try {
        const q = resolveQuota(req.user.id);
        return { credits: q.credits, unlimited: q.unlimited, daily_limit: q.daily_limit, used_today: q.used_today };
      } catch { return null; }
    };

    // Persist an updated intake pin (十问/舌象 or 咨询背景) if the client sent one
    const activePin = pin || session.pin || '';
    if (pin && pin !== session.pin) {
      updateSessionPin(sessionId, pin);
    }

    // Keep a transient user message; it is persisted only when generation starts
    const userMsgId = addMessage(sessionId, 'user', content);

    // Auto-title from first user question
    if (countMessages(sessionId) <= 1) {
      const title = content.replace(/\s+/g, ' ').slice(0, 16);
      renameSession(sessionId, title || mod.name);
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

    // —— 容量保护：并发生成超过保守阈值时进入 FIFO 排队，前端实时显示排位 ——
    //    （阈值管理员可调；默认并发 300 / 队列 500 / 单次排队上限 45s）
    let capacityTicket = null;
    try {
      capacityTicket = await acquireGenerationSlot(req.user.id, {
        signal: abortController.signal,
        onQueued: (position, estWaitSec) => sse(reply, { type: 'queue', position, est_wait_s: estWaitSec }),
      });
    } catch (capErr) {
      clearInterval(heartbeat);
      const code = capErr.code || 'busy';
      const msg = code === 'queue_full'
        ? '当前使用人数已达瞬时上限，服务器正满负荷运行，请 1-2 分钟后再试。'
        : code === 'queue_timeout'
          ? `${capErr.message}（你的排队请求已释放，未扣除额度）`
          : '请求已取消。';
      sse(reply, { type: 'error', code, message: msg, retry_after_s: capErr.retryAfterS || 60 });
      // 用户消息保留（刷新可见「发了但未生成」），不扣额度、不写 usage
      reply.raw.end();
      return;
    }

    // Build conversation
    const history = [];
    const rows = listRecentMessages(sessionId, 30);
    for (const r of rows) {
      if (r.role === 'system') continue;
      if (r.id === userMsgId) continue; // 本轮提问稍后单独拼，避免重复
      history.push({ role: r.role, content: r.content });
    }

    const profile = getProfile(req.user.id);
    const provider = getSetting('llm_provider') === 'dsweb' ? 'dsweb' : 'api';

    // —— 模块人设 + 模块 RAG ——
    const sysPrompt = MODULE_PROMPTS[moduleId] || MODULE_PROMPTS.tcm;
    // 点名加权：佛门模块里用户说「请印光大师开示」，优先取印光的教法而不是同宗派其他祖师
    const boostDirs = detectBoostDirs(mod, content);
    const chunks = moduleId === 'tcm'
      ? retrieve(content + '\n' + activePin, 8)
      : retrieveForModule(content + '\n' + activePin, mod, 8, 7000, { boostDirs });

    // —— 工具脚本（排盘/抽牌）：命中请求标记时先跑脚本，结果并入上下文 ——
    let toolOut = null;
    try {
      toolOut = await runModuleTool(moduleId, content, getSetting);
      if (toolOut?.ran) {
        sse(reply, { type: 'tool', label: toolOut.label });
      }
    } catch (e) {
      fastify.log.warn({ err: String(e) }, 'module tool failed');
    }

    let sysContent = sysPrompt
      + (activePin ? `\n\n【本次${pinLabel(moduleId)}固定背景（用户提交的资料摘录）】\n` + activePin : '')
      + profileBlock(profile)
      + '\n\n' + buildRagBlock(chunks);
    if (toolOut?.ran) {
      sysContent += `\n\n【${toolOut.label}】\n${toolOut.output}\n（以上为脚本计算结果，解读必须与之一致；数值与文字不得改动）`;
    }

    // —— system 消息的两种下法 ——
    // 部分 OpenAI 兼容中转（如 aitrybest）会丢弃 system 角色，模型只看到裸提问。
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
          { role: 'user', content: sysContent + '\n\n【用户发言】\n' + content },
        ];

    let full = '';
    try {
      sse(reply, { type: 'start', user_msg_id: userMsgId });
      if (provider === 'dsweb') {
        // —— 网页版 DeepSeek（0 Token）：把系统指令与模块上下文并入单条网页消息 ——
        const dsPort = Number(getSetting('dsweb_port') || 9223);
        const dsExpert = getSetting('dsweb_expert') !== 'false';
        const compactRag = chunks.length
          ? chunks.map((c, i) => `〔摘录${i + 1}〕${(c.content || '').slice(0, 400)}`).join('\n')
          : '';
        const webPrompt = [
          '【角色设定】' + sysPrompt.split('【输出格式')[0].split('【教学原则】')[0].slice(0, 1200),
          activePin ? `【${pinLabel(moduleId)}背景】\n` + activePin : '',
          profileBlock(profile),
          compactRag ? '【知识库摘录（回答时参考，禁止照抄）】\n' + compactRag : '',
          toolOut?.ran ? `【${toolOut.label}】\n${toolOut.output.slice(0, 8000)}` : '',
          '【用户发言】\n' + content,
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
        chargeCredit(`「${mod.name}」消耗 · ${provider}`);
        sse(reply, { type: 'done', message_id: asstId, quota: quotaSnapshot() });
      } else {
        sse(reply, { type: 'error', message: '本次未收到有效回复，请重试。' });
      }
    } catch (err) {
      // 出口脱敏（安全）：上游错误体/URL 可能夹带 Authorization 头或密钥（部分中转与 WAF 会回显请求头），
      // 完整原因只进服务端日志，客户端只拿到固定文案 + 一个可追查的错误短号。
      const ref = errorRef();
      fastify.log.error({
        err: String(err),
        detail: err?.detail,
        ref,
        userId: req.user.id,
        module: moduleId,
      }, 'chat generation failed');
      const msg =
        provider === 'dsweb' ? (
          redact(
            '网页版 DeepSeek 调用失败：' + (err.message || String(err)).slice(0, 200)
            + (/凭证|token|登录|未授权|401|403/i.test(String(err))
              ? '（登录凭证可能已失效，请在管理后台「模型设置 → 粘贴登录凭证」重新导入）'
              : '（管理员可在管理后台「模型设置」检查接入配置）'),
          )
        )
        : err.code === 'no_api_key' ? '未配置模型通道：请管理员在「模型设置」中填写真实 API Key（若已是占位值请替换），或切换到网页版 DeepSeek（0 Token）通道。'
        : err.code === 'auth' ? '模型服务鉴权失败：API Key 无效或已过期。请管理员在「模型设置」中更新 Key，或切换到网页版 DeepSeek（0 Token）通道。'
        : err.code === 'rate_limit' ? '模型服务繁忙，请稍后重试。'
        // 以下两类原本会把上游原文带给用户（含密钥风险）：改为固定文案 + 错误编号
        : err.code === 'network' ? `无法连接模型服务（错误编号 ${ref}，详情见服务端日志）。`
        : err.code === 'upstream' ? `模型服务返回错误（错误编号 ${ref}，详情见服务端日志）。`
        : `模型服务暂不可用，请稍后再试（错误编号 ${ref}）。`;
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
        chargeCredit(`中断返回消耗 · ${provider}`);
        sse(reply, { type: 'done', message_id: asstId, quota: quotaSnapshot() });
      } else {
        sse(reply, { type: 'error', message: msg });
      }
    } finally {
      clearInterval(heartbeat);
      // 容量名额归还：成功/失败/客户端断开三条路都从这里出，必须释放给排队的请求
      if (capacityTicket) releaseCapacity();
      reply.raw.end();
    }
  });
}
