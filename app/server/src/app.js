import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import config from './config.js';
import { createAuthenticate } from './lib/auth.js';
import { configuredAdminUsername, configuredAdminExists, findCaseCollisions, getSetting } from './db.js';
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import chatRoutes from './routes/chat.js';
import profileRoutes from './routes/profile.js';
import adminRoutes from './routes/admin.js';
import adminUserRoutes from './routes/admin-users.js';
import checkinRoutes from './routes/checkin.js';
import subscriptionRoutes from './routes/subscription.js';
import internalRoutes from './routes/internal.js';
import systemRoutes from './routes/system.js';
import moduleRoutes from './routes/modules.js';
import { loadKnowledge } from './knowledge/loader.js';
import { redact } from './lib/redact.js';

export async function startServer() {
  // 代理信任（安全）：默认不信任任何代理头 —— 若信任，攻击者可用伪造的
  // X-Forwarded-For 每次换一个 IP，把登录限流完全绕过（已实测）。因此：
  //   本机/桌面（无代理）        → 不设或 TRUST_PROXY=false，req.ip 取 socket 地址（不可伪造）
  //   容器/宝塔反代（单跳）      → TRUST_PROXY=1，只信任紧邻的一跳
  const trustProxyEnv = process.env.TRUST_PROXY;
  const trustProxy = trustProxyEnv === undefined || trustProxyEnv === ''
    ? false
    : (trustProxyEnv === 'true' ? true : Number(trustProxyEnv) || false);

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    trustProxy,
    bodyLimit: 1024 * 1024,
    // 不把请求头/凭据写进日志
    disableRequestLogging: process.env.LOG_REQUESTS !== 'true',
  });

  await app.register(cookie);
  // CORS（安全）：默认关闭跨域（同源即可正常使用）。需要跨域时必须显式列白名单，
  // 否则任意站点都能带凭据读 /api/auth/me、/api/sessions 等。
  const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (corsOrigins.length) {
    await app.register(cors, { origin: corsOrigins, credentials: true });
  } else if (process.env.CORS_ALLOW_ANY === 'true') {
    // 显式选择的开发模式：不加 credentials，避免「任意站点带凭据读数据」
    await app.register(cors, { origin: true, credentials: false });
    app.log.warn('CORS_ALLOW_ANY=true —— 允许任意来源跨域（仅建议本地调试使用）');
  }
  await app.register(rateLimit, {
    global: false, // per-route limits only
    // 限流键用 req.ip：能否被伪造取决于上面的 trustProxy 配置 ——
    //   直连部署（默认不信任代理）→ req.ip 取 socket 地址，伪造 XFF 无效；
    //   反代部署（TRUST_PROXY=1）→ req.ip 取代理写入的真实客户端 IP。
    // 刻意不用 socket 地址：反代后全站会共用同一个限流桶，一次爆破就能把所有人挡在门外。
    // 真正的防爆破主力是账号维度节流（见 lib/throttle.js，与 IP 无关）。
    keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  });

  // Security headers — defense in depth even behind a proxy
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    // CSP：本应用是纯自托管 SPA（无第三方脚本/CDN）；样式需要 inline（React 内联 style 属性）
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
      + "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    // HSTS 只在确实走 TLS 时下发（直连 http 下发了会把自己锁死）
    if (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    // 含用户数据的 JSON 响应不得进任何缓存（含中间代理/浏览器 bfcache）
    if (typeof req.url === 'string' && req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      reply.header('Pragma', 'no-cache');
    }
    return payload;
  });

  // 统一错误出口（安全）：任何未预期异常只回固定文案，绝不把堆栈/上游响应体/密钥带给客户端。
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      app.log.error({ err, url: req.url, method: req.method }, 'unhandled error');
      return reply.code(500).send({ error: 'internal', message: '服务内部错误，请稍后重试' });
    }
    // 4xx（如请求体不是合法 JSON）保留可读原因
    return reply.code(status).send({ error: err.code || 'bad_request', message: redact(err.message || '请求无效') });
  });

  // Auth decorator must be on the root instance BEFORE any route plugin registers,
  // because route definitions evaluate `fastify.authenticate` at registration time.
  app.decorateRequest('user', null);
  app.decorate('authenticate', createAuthenticate());

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(sessionRoutes, { prefix: '/api/sessions' });
  await app.register(profileRoutes, { prefix: '/api/profile' });
  await app.register(chatRoutes, { prefix: '/api/chat' });
  await app.register(checkinRoutes, { prefix: '/api/checkin' });
  await app.register(subscriptionRoutes, { prefix: '/api/subscription' });
  await app.register(moduleRoutes, { prefix: '/api/modules' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(adminUserRoutes, { prefix: '/api/admin' });
  await app.register(systemRoutes, { prefix: '/api/system' });
  await app.register(internalRoutes, { prefix: '/internal' });

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString(), version: process.env.APP_VERSION || 'dev' }));

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

  // 管理员配置自检：配错 ADMIN_USERNAME 会导致无人能进后台（安全阀见 db.isAdminUser）
  const adminName = configuredAdminUsername();
  if (adminName && !configuredAdminExists()) {
    app.log.warn(
      `ADMIN_USERNAME="${adminName}" 指定的账号尚未注册 —— 该用户名注册后才会成为管理员；` +
      '在此之前沿用老规则（第一个注册的用户）。请确认用户名拼写无误。',
    );
  }
  // 老库安全自检：库里若已存在大小写重复的账号，其中可能是被抢注的管理员名变体，
  // 必须由管理员人工处理（本系统不会自动改名/删号）。
  try {
    const collisions = findCaseCollisions();
    for (const c of collisions) {
      const isAdminClash = adminName && c.lname === adminName.toLowerCase();
      const msg = `发现大小写重复的账号：${c.names} —— 请管理员核对是否为冒名账号`
        + (isAdminClash ? '（其中包含配置的管理员名，风险较高）' : '');
      if (isAdminClash) app.log.error(msg); else app.log.warn(msg);
    }
  } catch { /* 自检失败不影响启动 */ }
  // 模型通道自检（2026-09-18 加）：本项目历史上栽过两次——
  //   ① 联调时把 llm_base_url 指向本机 mock（localhost:9099），联调结束没清掉，
  //      之后每次对话都是「无法连接模型服务」，用户只能看到错误编号；
  //   2 用占位 key（test-xxx）当真实 key 写进 .env，表现为 401 鉴权失败。
  // 这两类都能在启动时一眼看出来，所以在这里显式告警。
  try {
    const baseUrl = getSetting('llm_base_url') || config.llm.baseUrl || '';
    const apiKey = getSetting('llm_api_key') || config.llm.apiKey || '';
    const provider = getSetting('llm_provider') === 'dsweb' ? 'dsweb' : 'api';
    if (provider === 'api') {
      if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(baseUrl)) {
        app.log.warn(
          `模型通道指向本机地址（${baseUrl}）——如果是联调用的 mock 服务，请确认它仍在运行；`
          + '否则请在「模型设置」中改回真实服务地址。',
        );
      }
      if (apiKey && /^(test|sk-test|your|xxx|placeholder|demo)/i.test(apiKey)) {
        app.log.warn('模型 API Key 看起来是占位值（以 test/your/xxx 等开头）——对话会返回鉴权失败，请在「模型设置」中填写真实 Key。');
      }
      if (!apiKey) app.log.warn('未配置模型 API Key —— 对话将不可用（可在管理后台「模型设置」配置，或改用网页版 DeepSeek 通道）。');
    }
  } catch { /* 自检失败不影响启动 */ }

  // 安全提示：未配置 APP_SECRET 时每次重启都会换密钥（会话失效）——生产必须配置
  if (!process.env.APP_SECRET) {
    app.log.warn('APP_SECRET 未配置：本次使用随机临时密钥，重启后所有登录态失效。生产环境请在 .env 中配置。');
  }
  if (process.env.CORS_ALLOW_ANY === 'true') {
    app.log.warn('CORS_ALLOW_ANY=true：已允许任意来源跨域访问（仅建议本地调试使用）。');
  }

  try {
    loadKnowledge();
  } catch (err) {
    app.log.error({ err }, 'knowledge index failed — chat will fall back to persona-only mode');
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`xuanshu server listening on http://${config.host}:${config.port}`);
  return app;
}
