# 倪海厦中医问诊 · Web 应用

将「倪海厦 Skill」知识库（伤寒论/金匮/医案/六经辨证）包装为带用户体系的 Web 问诊应用，界面风格参考 DeepSeek，专为中医问诊场景优化。

## 功能

- **用户注册 / 登录**：JWT + HttpOnly Cookie，scrypt 加盐哈希（兼容历史 argon2 哈希）；第一个注册的用户自动成为管理员
- **问诊会话**：类 DeepSeek 侧边栏会话列表，问诊记录云端持久化（SQLite）
- **流式回答**：SSE 流式输出，倪海厦口吻 + 六经辨证 + 经方条文卡片
- **中医问诊单**：主诉 + 十问 + 舌象/脉象快速勾选，自动生成结构化摘要随会话固定携带
- **体质档案**：性别/年龄/身高体重/基础疾病，问诊时自动注入 AI 上下文
- **双模型通道**：
  - **API Key 模式**：任意 OpenAI 兼容服务（DeepSeek/Kimi/通义/vLLM）
  - **网页版 DeepSeek（0 Token）**：CDP 驱动专用浏览器登录 chat.deepseek.com，直接走网页版对话额度，不消耗 API Token（桌面/本机推荐）
- **可视化模型配置（管理员）**：侧边栏「⚙️ 模型设置」在线切换接入方式、填写配置，保存即生效；Key 只存服务器，前端只见打码值
- **macOS 桌面版（Tauri DMG）**：内置本地服务端与知识库，双击即用，数据存本机
- **免责警示**：首次使用须勾选同意「使用须知」；每条 AI 回复下方附生成内容标注；输入区常驻急症就医提醒
- **响应式**：PC 端侧边栏布局，移动端抽屉式菜单 + 底部输入框
- **知识检索**：本地 RAG（字二元组 + 关键词打分）从 6,000+ 知识块检索相关条文注入提示词

## 架构

```
浏览器 ──► Caddy（静态资源 + /api 反代 + 自动 HTTPS）
              │
              ▼
        Fastify API ──► OpenAI 兼容 LLM（DeepSeek 等，服务端调用）
        + SQLite（用户/会话/消息）
        + 知识库 markdown（本地检索）
```

**安全设计（防 API Key 泄露）**：

1. `LLM_API_KEY` 只存在于服务器（`.env` 或管理员面板写入的数据库），浏览器端**零密钥、零配置**；管理面板回显的只是打码值（如 `sk-t****3456`）
2. API 容器不对外暴露端口，仅内网由 Caddy 反代，外部只能访问 80/443
3. 会话令牌走 `HttpOnly` + `SameSite=Lax` Cookie，前端 JS 无法读取；`APP_SECRET` 用于签名
4. Caddy 自动配置安全响应头（nosniff / X-Frame-Options / Referrer-Policy）
5. 认证接口与对话接口均有速率限制；输入长度限制（消息 4000 字符）
6. `.gitignore` 已排除 `.env`、`server/data/`；仓库不含任何密钥

**免责与合规设计**：

1. 首次使用强制阅读「使用须知」并勾选同意（AI 生成内容、非医疗建议、急症拨打 120、勿自行抓药）
2. 每条 AI 回复下方固定标注「⚠️ 以上内容由 AI 生成，仅供中医学习参考，不构成医疗建议」
3. 输入区常驻完整免责声明与急症就医提醒
4. AI 系统提示词内置固定免责框输出规则（常规/重症/急救三版）

## 快速部署（Docker）

前置：服务器安装 Docker 与 Docker Compose v2。

```bash
cd app
cp .env.example .env
# 编辑 .env：填写 LLM_API_KEY、APP_SECRET（openssl rand -hex 32 生成）
# 填写 DOMAIN（真实域名则自动签发 HTTPS 证书；留空或 localhost 则走 HTTP）

docker compose up -d --build
```

- 访问 `http://服务器IP` 或 `https://你的域名`
- 更新：`docker compose pull && docker compose up -d --build`
- 日志：`docker compose logs -f`
- 数据备份：SQLite 数据库在 Docker 卷 `app_data` 中（`docker volume inspect app_data`）

### 开发模式（本地）

```bash
# 终端 1 —— 后端
cd server
cp ../.env.example .env   # 填 LLM_API_KEY
npm install
LLM_API_KEY=sk-xxx node src/index.js     # 默认 :8080

# 终端 2 —— 前端（Vite dev，/api 自动代理到 :8080）
cd web
npm install
npm run dev                               # http://localhost:5173
```

### 模型配置（管理员面板）

部署后用**第一个注册的账号**登录（该账号自动成为管理员），侧边栏点「⚙️ 模型设置」：

**方式一：API Key 模式**（服务器部署推荐）
- **接口地址 Base URL**：如 `https://api.deepseek.com`（任何 OpenAI 兼容服务均可）
- **模型名称**：如 `deepseek-chat`
- **API Key**：保存即生效，无需重启；已保存时留空表示不修改

**方式二：网页版 DeepSeek（0 Token，本机/桌面版推荐）**
- 点「🌐 打开浏览器登录」→ 在弹出的专用浏览器窗口登录 chat.deepseek.com（登录一次长期有效）
- 点「🔍 检测登录状态」确认后即可问诊——对话直接走网页版额度，**不消耗 API Token**
- 原理：内置 CDP 驱动（参考 obsidian-ai-explainer），自动注入倪师提示词与问诊上下文并发送、抓取网页版回复
- 注意：需本机安装 Chrome/Edge；网页版有频率与风控限制；此方式仅在桌面版/本机服务可用（服务器无显示环境无法登录）

配置优先级：数据库配置（面板）> `.env` 环境变量。也可用 `ADMIN_USERNAME` 环境变量指定管理员用户名。

### macOS 桌面版（DMG）

```bash
cd desktop
npm install
npm run build        # 构建 sidecar + Tauri DMG
# 产物: src-tauri/target/release/bundle/dmg/nihaixia_1.0.0_aarch64.dmg
```

桌面版特点：双击即用、无需 Docker；本地服务端与 SQLite 数据都存在本机（`~/Library/Application Support/com.nihaixia.desktop/`）；「网页版 DeepSeek」0 Token 问诊开箱可用。注意：桌面版未做 Apple 公证，首次打开需右键 →「打开」绕过 Gatekeeper。

### 环境变量

| 变量 | 必填 | 说明 |
|------|:---:|------|
| `LLM_API_KEY` | ✅ | DeepSeek 或任意 OpenAI 兼容服务的 API Key |
| `APP_SECRET` | ✅ | 会话令牌签名密钥，`openssl rand -hex 32` 生成 |
| `LLM_BASE_URL` | | 默认 `https://api.deepseek.com` |
| `LLM_MODEL` | | 默认 `deepseek-chat` |
| `DOMAIN` | | Caddy 站点域名；真实域名自动 HTTPS |
| `DB_PATH` | | SQLite 文件路径（默认容器内 `/app/data/nihaixia.db`） |
| `PORT`/`HOST` | | API 监听（默认 8080/0.0.0.0） |

## 自定义知识库

把任意 markdown 放入 `server/knowledge/` 下对应目录即可在启动时自动索引：

- `knowledge/skill/` — 主技能文件与表达风格
- `knowledge/modules/` — 知识模块（伤寒/金匮/内经/本草…）
- `knowledge/cases/` — 医案库
- `knowledge/distilled/` — 蒸馏速查层
- `knowledge/research/` — 研究资料

## 目录结构

```
app/
├── docker-compose.yml       # 部署编排（api + web）
├── .env.example             # 环境变量模板（密钥不提交）
├── server/                  # Fastify + SQLite + RAG + LLM 代理
│   ├── Dockerfile
│   ├── src/
│   │   ├── index.js         # 入口（安全头/插件/路由挂载）
│   │   ├── db.js            # SQLite 建表与 CRUD
│   │   ├── llm.js           # OpenAI 兼容流式调用
│   │   ├── knowledge/       # RAG：索引、检索、系统提示词
│   │   └── routes/          # auth / sessions / profile / chat(SSE)
│   └── knowledge/           # 知识库 markdown（自动索引）
└── web/                     # React + Vite 前端
    ├── Dockerfile           # 构建 + Caddy 运行
    ├── Caddyfile            # 静态托管 + /api 反代 + 安全头
    └── src/
        ├── components/      # ChatPage / Sidebar / AuthPage / IntakeSheet …
        └── lib/api.js       # 同源 API 客户端（无任何密钥）
```

## 免责声明

本应用内容仅供中医学习与学术研究，不构成医疗诊断、处方或个体化治疗建议。身体不适请咨询执业中医师；急性危重症请立即就医。
