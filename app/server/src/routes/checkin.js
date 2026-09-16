// 每日打卡（签到）与额度账户。
//
// GET  /api/checkin  —— 签到状态 + 额度概览 + 额度流水（用户端面板用）
// POST /api/checkin  —— 执行打卡（服务端强制：每自然日一次 + 可选 CF Turnstile 人机校验）
//
// 防刷的三道闸：
//   1. 唯一索引 (user_id, day)：并发/重放也只能落一条
//   2. Cloudflare Turnstile：配好密钥后必须带有效 token（见 lib/turnstile.js）
//   3. 路由级限流：1 分钟 12 次，脚本狂刷直接被 429

import {
  checkinStatus, doCheckin, resolveQuota, listCreditLog,
  getCheckinSettings, expireSubscriptions,
} from '../db.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { sendError } from '../lib/validate.js';

export default async function checkinRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] };
  const rateOpts = { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } };

  fastify.get('/', auth, async (req) => {
    expireSubscriptions();
    return {
      checkin: checkinStatus(req.user.id),
      quota: resolveQuota(req.user.id),
      ledger: listCreditLog(req.user.id, 20),
    };
  });

  fastify.post('/', { preHandler: [fastify.authenticate], ...rateOpts }, async (req, reply) => {
    const settings = getCheckinSettings();
    if (!settings.enabled) return sendError(reply, 'checkin_disabled', '签到功能已关闭，请联系管理员', 403);

    if (settings.captchaEnabled) {
      const token = String(req.body?.cf_token || '').trim();
      const v = await verifyTurnstile(settings.secretKey, token, req.ip || '');
      if (!v.ok) {
        const hint = v.code === 'missing_token'
          ? '请先完成人机校验再签到'
          : '人机校验未通过，请刷新页面后重试';
        fastify.log.warn({ code: v.code, errorCodes: v.errorCodes }, 'checkin captcha rejected');
        return sendError(reply, 'captcha_failed', hint, 400);
      }
    }

    const r = doCheckin(req.user.id, { ip: req.ip || '' });
    if (!r.ok) {
      if (r.code === 'already') return sendError(reply, 'already', '今日已签到，明天再来', 409);
      if (r.code === 'disabled') return sendError(reply, 'checkin_disabled', '签到功能已关闭', 403);
      return sendError(reply, 'checkin_failed', '签到失败，请稍后重试', 400);
    }
    return {
      ok: true,
      day: r.day,
      streak: r.streak,
      reward: r.reward,
      credited: r.credited,
      balance: r.balance,
      checkin: checkinStatus(req.user.id),
      quota: resolveQuota(req.user.id),
    };
  });
}
