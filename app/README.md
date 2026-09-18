# 玄枢 XuanShu · 传统智慧 AI 工作台

把传统术数拆成**工程化模块**：每位「先生」是一个独立模块（人设 + 专属知识库 + 计算脚本），用户按模块单独开通。
排盘、历法换算、抽牌这类「死规矩」一律由 Python 脚本算，AI 只做解读；流派与口径（子时换日、置闰法、规则集）先说清再下结论，信息不全先追问。

八个模块：岐黄问诊（倪海厦经方视角）· 四柱八字 · 奇门遁甲 · 紫微斗数 · 月老姻缘 · 堪舆风水 · 塔罗占卜 · 佛门问学（15 位祖师教学）。

## 功能

- **模块体系**：8 个独立模块，每个含角色人设 + 隔离的知识库（RAG 只在该模块目录内检索）+ 可选计算脚本；管理员可在后台逐个上/下线并给用户开通（支持「申请审批」与「自助即开」两种模式）
- **脚本化计算**：八字排盘（零依赖）、奇门定局（lunar_python）、塔罗抽牌（可复现 seed）由服务端脚本执行，模型只解读不脑补
- **安全加固**：密钥出口脱敏（上游报错不回显凭据）、账号维度登录节流、CSP/no-store 响应头、子进程环境变量白名单、数据库 0600 —— 详见「安全模型」章节，回归用例 `server/smoke-security.sh`
- **用户注册 / 登录**：HMAC 签名 HttpOnly Cookie + token 版本号（改密/禁用即刻失效）；scrypt 加盐哈希（兼容历史 argon2 哈希）；管理员由 .env 的 `ADMIN_USERNAME` 指定
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

### 管理员

管理员账号**由配置文件指定**（不再由「第一个注册的用户」自动担任）：

```bash
# app/.env
ADMIN_USERNAME=你的用户名     # 必须是站点里已注册（或即将注册）的用户名
```

- 修改后重启生效：`docker compose up -d`
- 未配置时向后兼容老规则（第一个注册的用户），后台会显示提示建议尽快指定
- 若 `ADMIN_USERNAME` 填的用户名尚未注册，系统会记录启动告警并暂时沿用老规则，
  该用户名注册后自动交接 —— 避免配置写错导致无人能进后台

### 模型配置（管理员面板）

管理员登录后，侧边栏点「🛡️ 管理后台」→「⚙️ 模型设置」：

**方式一：API Key 模式**（服务器部署推荐）
- **接口地址 Base URL**：如 `https://api.deepseek.com`（任何 OpenAI 兼容服务均可）
- **模型名称**：如 `deepseek-chat`
- **API Key**：保存即生效，无需重启；已保存时留空表示不修改

**方式二：网页版 DeepSeek（0 Token）**
- **服务器/桌面版均可用**。两条通道自动选择：
  - **直连通道（推荐）**：保存一次登录凭证（userToken）后，服务端直接用该凭证调用网页版接口，
    无需浏览器、不占资源。凭证获取：在浏览器登录 chat.deepseek.com → F12 → Console →
    `copy(localStorage.getItem('userToken'))` → 粘贴到「🔐 粘贴登录凭证」
  - **浏览器通道（桌面版备用）**：未配置凭证时，驱动专用浏览器窗口自动操作网页版
- 对话走网页版额度，**不消耗 API Token**；点「🔍 检测登录状态」可查看当前通道与账号
- 原理：直连通道在本地复现网页端的 PoW（工作量证明，复用官方 WASM）与流式协议；
  浏览器通道移植自 obsidian-ai-explainer（CDP 驱动）
- 注意：网页版有频率与风控限制，请适度使用；凭证失效后重新粘贴即可

配置优先级：数据库配置（面板）> `.env` 环境变量。

### 管理后台（🛡️ 侧边栏入口，仅管理员可见）

| 标签页 | 功能 |
|--------|------|
| 概览 | 用户数/会话数/调用量/活跃度/字符量统计卡 |
| 用户管理 | 搜索筛选、新建、批量选择、批量启用/禁用/删除、编辑（改名/备注）、重置密码、删除（含影响范围确认）、导出 CSV |
| 对话记录 | 全站会话列表（按用户/标题过滤）、完整对话详情、关键词全文搜索 |
| 使用报表 | 近 7/14/30/90 天调用量柱状图、按用户/按通道统计 |
| 模型设置 | API Key / 网页版 DeepSeek 切换与登录 |
| 站点设置 | 注册开关、管理员来源、操作审计日志 |
| 系统更新 | 一键拉取部署（需服务器配 updater） |

安全约束：管理员不能禁用/删除/重命名自己；重置密码或禁用用户会使该用户**已登录的会话立即失效**；所有管理操作写入审计日志。

### macOS 桌面版（DMG）

```bash
cd desktop
npm install
npm run build        # 构建 sidecar + Tauri DMG
# 产物: src-tauri/target/release/bundle/dmg/nihaixia_1.0.0_aarch64.dmg
```

桌面版特点：双击即用、无需 Docker；本地服务端与 SQLite 数据都存在本机（`~/Library/Application Support/com.nihaixia.desktop/`）；「网页版 DeepSeek」0 Token 问诊开箱可用。注意：桌面版未做 Apple 公证，首次打开需右键 →「打开」绕过 Gatekeeper。

### iPhone / iPad 使用（无需 App Store）

服务端以 0.0.0.0 监听，手机与电脑在同一网络时，用 Safari 访问 `http://<电脑IP>:<端口>`，登录后点底部「分享」→「添加到主屏幕」——得到独立图标的全屏 App。

说明：
- 手机端与电脑端共用同一服务与数据，问诊记录实时同步
- 网页版 DeepSeek（0 Token）的浏览器跑在电脑上，手机端发起问诊同样可用
- macOS 首次可能弹防火墙授权，点「允许」；请勿在公共 Wi-Fi 下开放使用

### 环境变量

| 变量 | 必填 | 说明 |
|------|:---:|------|
| `LLM_API_KEY` | ✅ | DeepSeek 或任意 OpenAI 兼容服务的 API Key |
| `APP_SECRET` | ✅ | 会话令牌签名密钥，`openssl rand -hex 32` 生成 |
| `ADMIN_USERNAME` | | 管理员用户名（推荐明确指定；留空则第一个注册的用户为管理员） |
| `REGISTRATION_ENABLED` | | 是否开放注册（`true`/`false`，默认开放）；也可在后台「站点设置」在线切换 |
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

## 安全模型（2026-09 加固）

可复跑的回归用例：`bash app/server/smoke-security.sh`（31 项断言，覆盖下面全部条目）。

**密钥与凭据**
- LLM API Key / DeepSeek userToken / Turnstile Secret / 更新令牌只存在于服务端与数据库；管理接口只回 `has_key` + 掩码（如 `sk-S****2345`），提交掩码值会被拒绝（防误覆盖）。
- 上游报错不再原样回传给用户：部分中转/WAF 会回显请求头，历史版本曾导致普通用户在对话窗口里读到 API Key。现在客户端只拿到固定文案 + 错误编号，完整原因进服务端日志（`lib/redact.js` 对出口文本再做一道凭据脱敏兜底）。
- 模块脚本子进程使用**环境变量白名单**，不再透传 `process.env`（脚本拿不到任何服务端密钥）。
- `.env` 交付时 `chmod 600`；数据库文件（含口令哈希、会话记录）同样收敛为 `0600`。

**鉴权与会话**
- 会话 token = HMAC-SHA256 签名 + 过期时间 + `token_version`（改密/禁用即刻失效）；cookie 为 `httpOnly` + `sameSite=lax`，HTTPS 部署下 `secure`。
- 用户数据一律按 `req.user.id` 隔离；管理端点逐个 `requireAdmin` 守卫，后台读会话走 `/api/admin/conversations/*`（管理员身份不会让用户接口放行他人数据）。
- 管理员名保留：配置了 `ADMIN_USERNAME` 时，其**大小写变体**不允许被注册或改名（否则可用 `ALICE` 抢注 `alice` 的管理员身份）；用户名全程大小写不敏感查重，启动时自检历史冲突并告警。
- 模块权限两层：站点开关 × 用户开通；管理员为超集视角（可进入未上线模块排查）。

**抗爆破**
- 登录 10 次/分钟（IP 维度）+ **账号维度失败节流**（连续 5 次失败即锁定，指数退避至 15 分钟，成功即清零；与 IP 无关，伪造转发头绕不过）。
- `TRUST_PROXY` 默认不信任任何转发头：直连部署下伪造 `X-Forwarded-For` 无法绕过限流；容器/宝塔反代场景在 compose 中固定为 `1`（只信任紧邻一跳）。

**传输与浏览器侧**
- 安全响应头：`CSP`（仅允许同源脚本/样式）、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Cross-Origin-Opener-Policy`；HSTS 仅在确认走 TLS 时下发。
- 所有 `/api/*` 响应 `Cache-Control: no-store`，避免用户数据进任何中间缓存。
- 跨域默认**关闭**（同源即可正常使用）；确需跨域时用 `CORS_ORIGIN` 显式列白名单。
- 内部通道（`/internal/*`，桌面版登录窗口回传凭证用）额外要求来源为本机回环地址，避免局域网内其他设备调用。
- 前端无 `dangerouslySetInnerHTML`，Markdown 走 react-markdown 默认转义；任何密钥都不写 localStorage。

**已知取舍**
- 桌面版默认监听 `0.0.0.0`（为让同 Wi-Fi 的 iPhone PWA 连入），局域网内可访问登录页；防护靠登录节流 + 强口令，介意可改为仅本机监听。
- 桌面版 Tauri WebView 未启用 CSP（`tauri.conf.json` 的 `csp: null`），主体内容来自本地服务端页面。

## 免责声明

本应用内容仅供中医学习与学术研究，不构成医疗诊断、处方或个体化治疗建议。身体不适请咨询执业中医师；急性危重症请立即就医。

### 宝塔面板部署（推荐）

**方式一：一键脚本（推荐）**

```bash
# 服务器上执行（宝塔终端 / SSH）
cd /root
git clone https://github.com/youniszhang/nihaixia.git
cd nihaixia/app
bash deploy/install.sh
```

脚本会检查 Docker、交互式生成 `.env`、构建并启动服务。

**方式二：手动**

```bash
cd /root/nihaixia/app
cp .env.example .env
nano .env          # 填 LLM_API_KEY、APP_SECRET（openssl rand -hex 32）、PUBLIC_URL
docker compose up -d --build
```

**接入宝塔反向代理**

1. 宝塔「网站 → 添加站点」，绑定你的域名
2. 该站点「反向代理 → 添加反向代理」，目标 URL 填 `http://127.0.0.1:18080`
3. 申请 SSL 证书并开启「强制 HTTPS」

关键 `.env` 配置说明：

| 变量 | 说明 |
|------|------|
| `HTTP_PORT` | 本机监听端口（宝塔反代模式建议 `18080`，避免占用 80） |
| `COOKIE_SECURE` | HTTPS 站点填 `true`；纯 HTTP 访问填 `false`（否则无法登录） |
| `UPDATER_TOKEN` | 启用「系统更新」一键部署需配置（`openssl rand -hex 32`） |

**一键更新**

配置 `UPDATER_TOKEN` 后，服务端会启动 updater 容器（不映射公网端口，仅 Docker 内网可达）。
管理员登录后侧边栏出现「🔄 系统更新」：显示本地/远端版本、一键拉取 GitHub 最新代码并重建服务。

```bash
# 首次启用 updater（服务器执行）
cd /root/nihaixia/app
echo "UPDATER_TOKEN=$(openssl rand -hex 32)" >> .env
echo "UPDATER_URL=http://updater:8765" >> .env
docker compose --profile updater up -d --build
```

**数据持久化**：SQLite 数据库在 Docker 卷 `app_data`，容器重建不丢数据。备份：

```bash
docker run --rm -v app_data:/data -v $(pwd):/backup alpine tar czf /backup/nihaixia-backup.tar.gz -C /data .
```
