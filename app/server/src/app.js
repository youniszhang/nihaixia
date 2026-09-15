import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import os from 'node:os';
import config from './config.js';
import { createAuthenticate } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import chatRoutes from './routes/chat.js';
import profileRoutes from './routes/profile.js';
import adminRoutes from './routes/admin.js';
import internalRoutes from './routes/internal.js';
import systemRoutes from './routes/system.js';
import { loadKnowledge } from './knowledge/loader.js';

export async function startServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    credentials: true,
  });
  await app.register(rateLimit, {
    global: false, // per-route limits only
  });

  // Security headers — defense in depth even behind a proxy
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    return payload;
  });

  // Auth decorator must be on the root instance BEFORE any route plugin registers,
  // because route definitions evaluate `fastify.authenticate` at registration time.
  app.decorateRequest('user', null);
  app.decorate('authenticate', createAuthenticate());

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(sessionRoutes, { prefix: '/api/sessions' });
  await app.register(profileRoutes, { prefix: '/api/profile' });
  await app.register(chatRoutes, { prefix: '/api/chat' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(systemRoutes, { prefix: '/api/system' });
  await app.register(internalRoutes, { prefix: '/internal' });

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString(), version: process.env.APP_VERSION || 'dev' }));

  // 手机/PWA 访问地址。
  // - 服务器部署（STATIC_DIR 未设置 或 设置了 PUBLIC_URL）：返回对外地址
  // - 桌面版（STATIC_DIR 设置且无 PUBLIC_URL）：返回本机局域网地址
  app.get('/api/lan-info', { preHandler: [app.authenticate] }, async () => {
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    if (publicUrl) {
      return { urls: [publicUrl], mode: 'server', host: config.host, port: config.port };
    }
    const urls = [];
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
          urls.push(`http://${a.address}:${config.port}`);
        }
      }
    }
    // 部署在服务器且未显式配置 PUBLIC_URL 时，用请求 Host 兜底（宝塔反代场景）
    if (!urls.length) {
      return { urls: [], mode: 'server', hint: '请设置 PUBLIC_URL 环境变量为你的站点地址，例如 https://tcm.example.com' };
    }
    return { urls, mode: 'desktop', host: config.host, port: config.port };
  });

  // 桌面模式：本地服务端直接托管前端静态文件（服务器部署时由 Caddy 托管）
  if (process.env.STATIC_DIR) {
    await app.register(fastifyStatic, { root: process.env.STATIC_DIR });
    // SPA 回退：非 /api 的 GET 路由全部返回 index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, error: 'Not Found', statusCode: 404 });
    });
  }

  if (!config.llm.apiKey && process.env.ALLOW_NO_LLM !== 'true') {
    app.log.warn('LLM_API_KEY 未配置 — 启动完成但对话接口将返回错误（可在管理面板配置）');
  }

  try {
    loadKnowledge();
  } catch (err) {
    app.log.error({ err }, 'knowledge index failed — chat will fall back to persona-only mode');
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`nihaixia server listening on http://${config.host}:${config.port}`);
  return app;
}
