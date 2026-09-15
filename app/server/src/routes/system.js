// 服务器一键更新：通过内部 updater 容器执行 git pull + 重建镜像 + 重启。
// 设计参考 FileCodeBox 复盘手册：异步任务 + 状态轮询 + 不暴露 updater 到公网。
//
// 环境变量（服务器 /root/nihaixia/app/.env 配置）：
//   UPDATER_URL    例如 http://updater:8765
//   UPDATER_TOKEN  与 updater 容器共享的长随机串
// 未配置时接口返回「未启用」，桌面版无此能力。

import { isAdminUser } from '../db.js';
import { sendError } from '../lib/validate.js';

function updaterCfg() {
  const url = (process.env.UPDATER_URL || '').replace(/\/+$/, '');
  const token = process.env.UPDATER_TOKEN || '';
  return { url, token, enabled: Boolean(url && token) };
}

async function callUpdater(path, method = 'GET') {
  const { url, token } = updaterCfg();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  return { ok: res.ok, status: res.status, data };
}

export default async function systemRoutes(fastify) {
  const admin = { preHandler: [fastify.authenticate] };

  fastify.get('/status', admin, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const cfg = updaterCfg();
    if (!cfg.enabled) {
      return { enabled: false, message: '未启用一键更新（服务器需配置 UPDATER_URL / UPDATER_TOKEN）' };
    }
    try {
      const r = await callUpdater('/status');
      return { enabled: true, ...(r.data || {}) };
    } catch (err) {
      return { enabled: true, error: `无法连接更新服务：${(err.message || err).slice(0, 160)}` };
    }
  });

  fastify.post('/update', admin, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const cfg = updaterCfg();
    if (!cfg.enabled) return sendError(reply, 'not_enabled', '未启用一键更新', 400);
    try {
      const r = await callUpdater('/update', 'POST');
      return r.data;
    } catch (err) {
      return sendError(reply, 'updater_unreachable', `无法连接更新服务：${(err.message || err).slice(0, 160)}`, 502);
    }
  });

  fastify.post('/restart', admin, async (req, reply) => {
    if (!isAdminUser(req.user)) return sendError(reply, 'forbidden', '仅管理员可访问', 403);
    const cfg = updaterCfg();
    if (!cfg.enabled) return sendError(reply, 'not_enabled', '未启用一键更新', 400);
    try {
      const r = await callUpdater('/restart', 'POST');
      return r.data;
    } catch (err) {
      return sendError(reply, 'updater_unreachable', `无法连接更新服务：${(err.message || err).slice(0, 160)}`, 502);
    }
  });
}
