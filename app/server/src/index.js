import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import config from './config.js';
import { createAuthenticate } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import chatRoutes from './routes/chat.js';
import profileRoutes from './routes/profile.js';
import adminRoutes from './routes/admin.js';
import { loadKnowledge } from './knowledge/loader.js';

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

app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

// Fail fast if the LLM key is missing at boot (unless explicitly allowed)
if (!config.llm.apiKey && process.env.ALLOW_NO_LLM !== 'true') {
  app.log.warn('LLM_API_KEY 未配置 — 启动完成但对话接口将返回错误');
}

try {
  loadKnowledge();
} catch (err) {
  app.log.error({ err }, 'knowledge index failed — chat will fall back to persona-only mode');
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`nihaixia server listening on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export default app;
