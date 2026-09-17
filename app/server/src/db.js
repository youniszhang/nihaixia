import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  age INTEGER,
  height_cm REAL,
  weight_kg REAL,
  body_notes TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新问诊',
  pin TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 用量日志：每次成功的模型调用记一行，供管理员报表统计
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  provider TEXT NOT NULL DEFAULT 'api',
  model TEXT DEFAULT '',
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  completion_chars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_log(created_at DESC);
`);

// ---------- migrations（老库补列，幂等）----------
function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
const userCols = tableColumns('users');
if (!userCols.includes('status')) {
  // active | disabled —— 禁用后无法登录，已有会话 token 也会被拦下
  db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}
if (!userCols.includes('last_login_at')) {
  db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
}
if (!userCols.includes('note')) {
  db.exec("ALTER TABLE users ADD COLUMN note TEXT DEFAULT ''");
}
if (!userCols.includes('token_version')) {
  // 改密/禁用时递增，旧签发 token 立即失效（token 无状态，需版本号兜底）
  db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
}

db.exec(`
-- 管理员操作审计（谁在什么时候改了谁）
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_username TEXT DEFAULT '',
  action TEXT NOT NULL,
  target TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
`);

// ---------- settings ----------
export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
export function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// 一次性修正（2026-09-15）：每日问诊上限在功能联调时被设为测试值 1，恢复为常用值 30
if (getSetting('daily_chat_limit') === '1') setSetting('daily_chat_limit', '30');

// ---------- 管理员判定 ----------
// 优先级：ADMIN_USERNAME（.env，唯一权威来源）> admin_user_id（老部署兼容）
// 设计变更（2026-09）：管理员写在配置文件里，不再由「第一个注册的用户」自动担任。
export function configuredAdminUsername() {
  return (process.env.ADMIN_USERNAME || '').trim();
}

// 配置的管理员账号是否已在库中存在
export function configuredAdminExists() {
  const name = configuredAdminUsername();
  if (!name) return false;
  return Boolean(findUserByNameVar(name));
}

export function isAdminUser(user) {
  if (!user) return false;
  const adminName = configuredAdminUsername();
  if (adminName) {
    if (String(user.username).toLowerCase() === adminName.toLowerCase()) return true;
    // 安全阀：配置的管理员账号还不存在（未注册/名字写错）时，保留老规则的管理员，
    // 避免整个站点失去管理员入口；该账号一旦注册，老规则自动失效。
    if (!configuredAdminExists()) {
      const adminId = getSetting('admin_user_id');
      return adminId != null && String(user.id) === String(adminId);
    }
    return false;
  }
  // 未配置 ADMIN_USERNAME：兼容老部署（历史上第一个注册用户 = 管理员）
  const adminId = getSetting('admin_user_id');
  return adminId != null && String(user.id) === String(adminId);
}

// 与 isAdminUser 同源的「目标用户是否管理员」判定（供后台校验用，避免逻辑漂移）
export function isAdminIdentity(user) {
  return isAdminUser(user);
}

// 是否存在可用的管理员账号（用于空库引导与注册开关例外）
export function hasConfiguredAdminAccount() {
  const adminName = configuredAdminUsername();
  if (adminName) return configuredAdminExists();
  const adminId = getSetting('admin_user_id');
  if (adminId == null) return false;
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(adminId);
  return Boolean(u);
}
function findUserByNameVar(name) {
  return db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(name);
}

// ---------- 注册开关 ----------
// 优先级：数据库设置（后台在线切换）> REGISTRATION_ENABLED 环境变量 > 默认关闭
// 默认关闭：本站不开放自助注册；账号由管理员在「用户管理」创建，或在「站点设置」
// 临时开启注册（也可用 .env 的 REGISTRATION_ENABLED=true 显式开启）。
export function isRegistrationOpen() {
  const stored = getSetting('registration_enabled');
  if (stored !== null) return stored !== 'false';
  const env = (process.env.REGISTRATION_ENABLED || '').trim().toLowerCase();
  if (env === 'false' || env === '0' || env === 'off') return false;
  if (env === 'true' || env === '1' || env === 'on') return true;
  return false;
}
// 是否已显式设置过（区分默认值）
export function registrationIsExplicit() {
  if (getSetting('registration_enabled') !== null) return true;
  const env = (process.env.REGISTRATION_ENABLED || '').trim();
  return env !== '';
}
// 空库首次启动时允许创建管理员账号（否则没人能进后台）
export function registrationRequiresBootstrap() {
  const { c } = db.prepare('SELECT COUNT(*) c FROM users').get();
  return c === 0;
}
export function registrationAllowed() {
  if (registrationRequiresBootstrap()) return true;
  return isRegistrationOpen();
}

// ---------- users ----------
export function createUser(username, passwordHash) {
  const r = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
  return { id: r.lastInsertRowid, username };
}
export function findUserByName(username) {
  // 邮箱形式用户名大小写不敏感（Gmail 等邮箱本身不区分大小写）；
  // 普通用户名仍精确匹配（兼容历史上区分大小写的账号）。
  const s = String(username || '').trim();
  if (s.includes('@')) {
    return db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(s);
  }
  return db.prepare('SELECT * FROM users WHERE username = ?').get(s);
}
export function findUserById(id) {
  return db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id);
}

// ---------- admin: users ----------
export function listUsersWithStats() {
  return db.prepare(`
    SELECT u.id, u.username, u.created_at, u.status, u.last_login_at, u.note,
      u.credits, u.daily_chat_limit,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
      (SELECT COUNT(*) FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.user_id = u.id AND m.role = 'user') AS question_count,
      (SELECT COUNT(*) FROM usage_log l WHERE l.user_id = u.id) AS call_count,
      (SELECT COUNT(*) FROM checkins c WHERE c.user_id = u.id) AS checkin_count,
      (SELECT s.plan_name FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active'
        AND (s.expires_at IS NULL OR s.expires_at > datetime('now')) ORDER BY s.id DESC LIMIT 1) AS plan_name,
      (SELECT s.expires_at FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active'
        AND (s.expires_at IS NULL OR s.expires_at > datetime('now')) ORDER BY s.id DESC LIMIT 1) AS plan_expires_at,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'pending') AS pending_subs
    FROM users u ORDER BY u.id ASC`).all();
}
export function setUserStatus(id, status) {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  // 禁用时让已签发的 token 立即失效
  if (status === 'disabled') bumpTokenVersion(id);
}
export function setUserNote(id, note) {
  db.prepare('UPDATE users SET note = ? WHERE id = ?').run(note, id);
}
export function setUserPassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  bumpTokenVersion(id); // 改密后旧会话全部失效
}
export function renameUser(id, username) {
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
}
export function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
export function touchLogin(id) {
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}
export function getUserStatus(id) {
  const row = db.prepare('SELECT status FROM users WHERE id = ?').get(id);
  return row ? row.status : null;
}
export function getUserTokenVersion(id) {
  const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(id);
  return row ? Number(row.token_version || 0) : null;
}
export function bumpTokenVersion(id) {
  db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(id);
}
// 批量操作：ids 为数字数组，返回实际影响条数。
// 整体包在事务里：任一失败则全部回滚，避免"禁用了一半"的中间态。
export function bulkSetUserStatus(ids, status) {
  const stmt = db.prepare('UPDATE users SET status = ? WHERE id = ?');
  const bump = db.prepare('UPDATE users SET token_version = COALESCE(token_version,0) + 1 WHERE id = ?');
  db.exec('BEGIN');
  try {
    let n = 0;
    for (const id of ids) {
      stmt.run(status, id);
      if (status === 'disabled') bump.run(id);
      n++;
    }
    db.exec('COMMIT');
    return n;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
export function bulkDeleteUsers(ids) {
  const stmt = db.prepare('DELETE FROM users WHERE id = ?');
  db.exec('BEGIN');
  try {
    let n = 0;
    for (const id of ids) { stmt.run(id); n++; }
    db.exec('COMMIT');
    return n;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- admin: audit ----------
export function addAudit({ actor, action, target = '', detail = '' }) {
  db.prepare(`INSERT INTO audit_log (actor_id, actor_username, action, target, detail)
    VALUES (?,?,?,?,?)`).run(
    actor?.id ?? null, actor?.username ?? '', String(action), String(target).slice(0, 200), String(detail).slice(0, 500),
  );
}
export function listAudit(limit = 100) {
  return db.prepare(`SELECT id, actor_username, action, target, detail, created_at
    FROM audit_log ORDER BY id DESC LIMIT ?`).all(Math.min(Number(limit) || 100, 500));
}

// LIKE 查询的通配符转义：用户输入含 % _ \ 时按字面匹配，避免"输入 % 命中全部"
function escapeLike(str) {
  return String(str).replace(/[\\%_]/g, (m) => '\\' + m);
}

// ---------- admin: conversations ----------
// 全站会话列表（可按用户过滤 / 关键词搜标题）
export function adminListSessions({ userId = null, q = '', limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (userId) { where.push('s.user_id = ?'); params.push(userId); }
  if (q) { where.push("s.title LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(q)}%`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT s.id, s.user_id, s.title, s.created_at, s.updated_at, u.username,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role='user') AS msg_count
    FROM sessions s JOIN users u ON u.id = s.user_id
    ${whereSql}
    ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) c FROM sessions s ${whereSql}`).get(...params).c;
  return { rows, total };
}

// 任意会话的消息（管理员视角，不校验归属）
export function adminGetSessionMessages(sessionId) {
  return db.prepare(`SELECT id, role, content, created_at FROM messages
    WHERE session_id = ? ORDER BY id ASC LIMIT 1000`).all(sessionId);
}
// 关键词全文搜索（内容）
export function adminSearchMessages(q, limit = 50) {
  return db.prepare(`
    SELECT m.id, m.session_id, m.role, m.content, m.created_at,
           s.title AS session_title, u.username, s.user_id
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    JOIN users u ON u.id = s.user_id
    WHERE m.content LIKE ? ESCAPE '\\'
    ORDER BY m.id DESC LIMIT ?`).all(`%${escapeLike(q)}%`, limit);
}

// ---------- admin: usage / reports ----------
export function logUsage({ userId, sessionId = null, provider = 'api', model = '', promptChars = 0, completionChars = 0 }) {
  db.prepare(`INSERT INTO usage_log (user_id, session_id, provider, model, prompt_chars, completion_chars)
    VALUES (?,?,?,?,?,?)`).run(userId, sessionId, provider, model, promptChars, completionChars);
}

// 当日已成功问诊次数（按 usage_log；北京自然日，容器 TZ=Asia/Shanghai）
export function usageCountToday(userId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM usage_log
    WHERE user_id = ? AND date(created_at, 'localtime') = date('now', 'localtime')`).get(userId)?.n || 0;
}

export function usageSummary() {
  const total = db.prepare(`SELECT
      COUNT(*) AS calls,
      COUNT(DISTINCT user_id) AS active_users,
      COALESCE(SUM(prompt_chars),0) AS prompt_chars,
      COALESCE(SUM(completion_chars),0) AS completion_chars
    FROM usage_log`).get();
  return total;
}

export function usageDaily(days = 14) {
  return db.prepare(`
    SELECT date(created_at, 'localtime') AS day,
      COUNT(*) AS calls,
      COUNT(DISTINCT user_id) AS users,
      COALESCE(SUM(prompt_chars),0) AS prompt_chars,
      COALESCE(SUM(completion_chars),0) AS completion_chars
    FROM usage_log
    WHERE date(created_at, 'localtime') >= date('now', 'localtime', ?)
    GROUP BY day ORDER BY day ASC`).all(`-${Number(days) - 1} days`);
}

export function usageByUser() {
  return db.prepare(`
    SELECT u.id, u.username, u.status,
      COUNT(l.id) AS calls,
      COALESCE(SUM(l.prompt_chars),0) AS prompt_chars,
      COALESCE(SUM(l.completion_chars),0) AS completion_chars,
      MAX(l.created_at) AS last_call_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count
    FROM users u LEFT JOIN usage_log l ON l.user_id = u.id
    GROUP BY u.id ORDER BY calls DESC`).all();
}

export function usageByProvider() {
  return db.prepare(`
    SELECT provider, COUNT(*) AS calls,
      COALESCE(SUM(prompt_chars),0) AS prompt_chars,
      COALESCE(SUM(completion_chars),0) AS completion_chars
    FROM usage_log GROUP BY provider ORDER BY calls DESC`).all();
}

// ---------- profile ----------
export function getProfile(userId) {
  return db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId) || null;
}
export function upsertProfile(userId, p) {
  db.prepare(`INSERT INTO profiles (user_id, nickname, gender, age, height_cm, weight_kg, body_notes, updated_at)
    VALUES (@user_id, @nickname, @gender, @age, @height_cm, @weight_kg, @body_notes, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      nickname=@nickname, gender=@gender, age=@age, height_cm=@height_cm,
      weight_kg=@weight_kg, body_notes=@body_notes, updated_at=datetime('now')`)
    .run({
      user_id: userId,
      nickname: p.nickname ?? '', gender: p.gender ?? '', age: p.age ?? null,
      height_cm: p.height_cm ?? null, weight_kg: p.weight_kg ?? null,
      body_notes: p.body_notes ?? '',
    });
}

// ---------- sessions ----------
export function createSession(userId, title = '新问诊', pin = '') {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, user_id, title, pin) VALUES (?,?,?,?)').run(id, userId, title, pin);
  return { id, title, pin };
}
export function listSessions(userId) {
  return db.prepare(`SELECT id, title, pin, created_at, updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id AND m.role='user') AS msg_count
    FROM sessions WHERE user_id = ? ORDER BY updated_at DESC`).all(userId);
}
export function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}
export function renameSession(id, title) {
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
}
export function updateSessionPin(id, pin) {
  db.prepare('UPDATE sessions SET pin = ? WHERE id = ?').run(pin, id);
}
export function touchSession(id) {
  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(id);
}
export function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ---------- messages ----------
export function addMessage(sessionId, role, content) {
  const r = db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?,?,?)').run(sessionId, role, content);
  touchSession(sessionId);
  return Number(r.lastInsertRowid);
}
export function listMessages(sessionId, limit = 200) {
  return db.prepare(`SELECT id, role, content, created_at FROM messages
    WHERE session_id = ? ORDER BY id ASC LIMIT ?`).all(sessionId, limit);
}
// 最近 N 条（长会话下 listMessages 的 ASC+LIMIT 会丢掉最新消息，
// 导致模型看不到本轮提问——chat 路由必须用这个）
export function listRecentMessages(sessionId, limit = 30) {
  const rows = db.prepare(`SELECT id, role, content, created_at FROM messages
    WHERE session_id = ? ORDER BY id DESC LIMIT ?`).all(sessionId, limit);
  return rows.reverse();
}
export function countMessages(sessionId) {
  return db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(sessionId).c;
}

// ================= 额度 / 每日打卡（签到） / 订阅 =================
//
// 额度语义（users.credits）：
//   NULL   = 不限次（老账号与「未启用额度制」时的默认值，保证既有部署行为不变）
//   整数   = 剩余问诊次数，每成功生成一次扣 1，扣到 0 后拒绝新的提问
// 用户每日上限（users.daily_chat_limit）：
//   NULL   = 跟随套餐 / 站点默认；整数（含 0）= 该用户的专属上限，0 表示不限
// 生效上限优先级：用户专属 > 生效中的订阅套餐 > 站点默认（settings.daily_chat_limit）

db.exec(`
-- 套餐（订阅计划）：管理员维护，用户端只读展示 + 申请
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  period_days INTEGER NOT NULL DEFAULT 30,
  daily_chat_limit INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 用户订阅：pending（申请待审批）/ active / rejected / expired / canceled
-- 套餐的额度与上限在下单时「快照」进本表：之后管理员改套餐不会追溯影响老订阅
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  plan_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  price_cents INTEGER NOT NULL DEFAULT 0,
  period_days INTEGER NOT NULL DEFAULT 30,
  daily_chat_limit INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  expires_at TEXT,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status, id DESC);

-- 每日打卡：每用户每自然日最多一条（北京自然日，容器 TZ=Asia/Shanghai）
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  reward INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 1,
  ip TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_user_day ON checkins(user_id, day);
CREATE INDEX IF NOT EXISTS idx_checkin_day ON checkins(day DESC);

-- 额度流水：发放 / 扣减 / 调整，全部留痕（对账与申诉用）
CREATE TABLE IF NOT EXISTS credit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  balance_after INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_log(user_id, id DESC);
`);

// 老库补列（幂等）：额度与专属每日上限
const quotaUserCols = tableColumns('users');
if (!quotaUserCols.includes('credits')) {
  db.exec('ALTER TABLE users ADD COLUMN credits INTEGER');
}
if (!quotaUserCols.includes('daily_chat_limit')) {
  db.exec('ALTER TABLE users ADD COLUMN daily_chat_limit INTEGER');
}

// 数字型站点设置的读取（空串/未设置 → 默认值）
function numSetting(key, def = 0) {
  const raw = getSetting(key);
  if (raw === null || raw === undefined || String(raw).trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
function boolSetting(key, def) {
  const raw = getSetting(key);
  if (raw === null || raw === undefined || String(raw).trim() === '') return def;
  return String(raw) !== 'false';
}

// 今天的北京自然日（YYYY-MM-DD）；offsetDays 用于取昨天算连签
export function localDay(offsetDays = 0) {
  if (!offsetDays) return db.prepare("SELECT date('now','localtime') AS d").get().d;
  const mod = `${offsetDays > 0 ? '+' : '-'}${Math.abs(offsetDays)} days`;
  return db.prepare("SELECT date('now','localtime',?) AS d").get(mod).d;
}

// ---------- 签到人机校验 站点设置 ----------
export function getCheckinSettings() {
  const siteKey = (getSetting('turnstile_site_key') || '').trim();
  const secretKey = (getSetting('turnstile_secret_key') || '').trim();
  return {
    enabled: boolSetting('checkin_enabled', true),
    reward: Math.max(0, Math.floor(numSetting('checkin_reward', 3))),
    streakBonus: Math.max(0, Math.floor(numSetting('checkin_streak_bonus', 2))),
    streakBonusMax: Math.max(0, Math.floor(numSetting('checkin_streak_bonus_max', 10))),
    // 只有 site key 与 secret 都配好才要求人机校验，避免「配一半」把用户挡在门外
    captchaEnabled: Boolean(siteKey && secretKey),
    siteKey,
    secretKey,
  };
}

// 某天签到的奖励：基础奖励 + 连签加成（带上限，避免无限滚雪球）
export function checkinRewardFor(streak, s = getCheckinSettings()) {
  return s.reward + Math.min(s.streakBonus * Math.max(0, streak - 1), s.streakBonusMax);
}

export function getCheckinOn(userId, day) {
  return db.prepare('SELECT * FROM checkins WHERE user_id = ? AND day = ?').get(userId, day) || null;
}

export function listCheckins(userId, limit = 30) {
  return db.prepare('SELECT day, reward, streak, created_at FROM checkins WHERE user_id = ? ORDER BY day DESC LIMIT ?')
    .all(userId, Math.min(Math.max(Number(limit) || 30, 1), 200));
}

export function checkinSummary() {
  const total = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM checkins').get();
  const today = db.prepare("SELECT COUNT(*) AS n FROM checkins WHERE day = date('now','localtime')").get();
  return { total: total.n, users: total.users, today: today.n, day: localDay() };
}

export function checkinDaily(days = 14) {
  return db.prepare(`
    SELECT day, COUNT(*) AS checkins, COUNT(DISTINCT user_id) AS users, COALESCE(SUM(reward),0) AS reward
    FROM checkins
    WHERE day >= date('now','localtime',?)
    GROUP BY day ORDER BY day ASC`).all(`-${Number(days) - 1} days`);
}

// 当天签到状态（只读，供前端渲染按钮/连签天数）
export function checkinStatus(userId) {
  const s = getCheckinSettings();
  const day = localDay();
  const today = getCheckinOn(userId, day);
  const y = getCheckinOn(userId, localDay(-1));
  const last = db.prepare('SELECT day, streak FROM checkins WHERE user_id = ? ORDER BY day DESC LIMIT 1').get(userId) || null;
  // 今天已签 → 今天的连签；今天未签但昨天签过 → 今天签到将是「昨天 + 1」
  const streak = today ? Number(today.streak) : (y ? Number(y.streak) : 0);
  const nextStreak = today ? Number(today.streak) : (y ? Number(y.streak) + 1 : 1);
  return {
    enabled: s.enabled,
    day,
    checked_in: Boolean(today),
    streak,
    next_streak: nextStreak,
    reward_today: today ? today.reward : 0,
    reward_next: checkinRewardFor(nextStreak, s),
    last_day: last ? last.day : null,
    captcha_enabled: s.captchaEnabled,
    captcha_site_key: s.captchaEnabled ? s.siteKey : '',
    history: listCheckins(userId, 30),
  };
}

// 执行签到：同一自然日只能签一次（唯一索引兜底并发）
export function doCheckin(userId, { ip = '' } = {}) {
  const s = getCheckinSettings();
  if (!s.enabled) return { ok: false, code: 'disabled' };
  const day = localDay();
  if (getCheckinOn(userId, day)) return { ok: false, code: 'already' };
  const y = getCheckinOn(userId, localDay(-1));
  const streak = y ? Number(y.streak) + 1 : 1;
  const reward = checkinRewardFor(streak, s);
  try {
    db.prepare('INSERT INTO checkins (user_id, day, reward, streak, ip) VALUES (?,?,?,?,?)')
      .run(userId, day, reward, streak, ip);
  } catch (err) {
    if (String(err).includes('UNIQUE')) return { ok: false, code: 'already' };
    throw err;
  }
  // 只有额度制账号真正加分；不限次账号仅记录签到与连签天数
  // （不能顺手把不限次账号改成额度制，那是悄悄降级）
  const u = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  const finite = u && u.credits != null;
  let balance = u ? (u.credits == null ? null : Number(u.credits)) : null;
  if (finite && reward > 0) balance = addCredits(userId, reward, 'checkin', `每日签到（连签 ${streak} 天）`);
  return { ok: true, code: 'ok', day, streak, reward, credited: Boolean(finite), balance };
}

// ---------- 额度 ----------
export function getUserCredits(userId) {
  const row = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  return row.credits == null ? null : Number(row.credits);
}

// 发放/调整额度（reason: checkin | subscribe | admin | gift）
export function addCredits(userId, delta, reason = 'admin', detail = '') {
  const cur = getUserCredits(userId);
  if (cur === null) {
    db.prepare('INSERT INTO credit_log (user_id, delta, balance_after, reason, detail) VALUES (?,?,?,?,?)')
      .run(userId, 0, null, reason, `${detail}（不限次账号，额度不生效）`.trim());
    return null;
  }
  const next = Math.max(0, cur + Math.floor(delta));
  db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(next, userId);
  db.prepare('INSERT INTO credit_log (user_id, delta, balance_after, reason, detail) VALUES (?,?,?,?,?)')
    .run(userId, Math.floor(delta), next, reason, detail);
  return next;
}

// 直接设定额度（管理员用）；value 传 null/'' 表示改为「不限次」
export function setUserCredits(userId, value, reason = 'admin', detail = '') {
  const cur = getUserCredits(userId);
  const next = (value === null || value === undefined || value === '')
    ? null
    : Math.max(0, Math.floor(Number(value)));
  if (next !== null && !Number.isFinite(next)) return cur;
  db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(next, userId);
  const delta = next === null ? 0 : next - (cur ?? 0);
  db.prepare('INSERT INTO credit_log (user_id, delta, balance_after, reason, detail) VALUES (?,?,?,?,?)')
    .run(userId, delta, next, reason, detail || (next === null ? '改为不限次' : `管理员设定为 ${next} 次`));
  return next;
}

export function setUserDailyLimit(userId, value) {
  const next = (value === null || value === undefined || value === '')
    ? null
    : Math.max(0, Math.floor(Number(value)));
  db.prepare('UPDATE users SET daily_chat_limit = ? WHERE id = ?').run(next, userId);
  return next;
}

// 扣 1 次额度：返回剩余额度；不限次返回 null；不足返回 -1（调用方应已先拦截）
export function consumeCredit(userId, detail = '') {
  const cur = getUserCredits(userId);
  if (cur === null) return null;
  if (cur <= 0) return -1;
  const next = cur - 1;
  db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(next, userId);
  db.prepare('INSERT INTO credit_log (user_id, delta, balance_after, reason, detail) VALUES (?,?,?,?,?)')
    .run(userId, -1, next, 'consume', detail);
  return next;
}

export function listCreditLog(userId, limit = 50) {
  return db.prepare('SELECT delta, balance_after, reason, detail, created_at FROM credit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(Math.max(Number(limit) || 50, 1), 200));
}

// 新用户开户额度：站点设置 default_credits 留空 = 不限次（沿用既有部署行为）；
// 填了数字则新注册/新建的用户按额度制开工（额度用完靠签到或订阅补充）。
export function applyDefaultCredits(userId) {
  const raw = getSetting('default_credits');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Math.max(0, Math.floor(Number(raw) || 0));
  return setUserCredits(userId, n, 'default', '新用户默认额度');
}

export function getDefaultCredits() {
  const raw = getSetting('default_credits');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

// ---------- 订阅 ----------
export function expireSubscriptions() {
  const r = db.prepare(`UPDATE subscriptions SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= datetime('now')`).run();
  return r.changes || 0;
}

// 生效中的订阅（过期的不算，不依赖定时清理）
export function activeSubscription(userId) {
  return db.prepare(`SELECT * FROM subscriptions
    WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY id DESC LIMIT 1`).get(userId) || null;
}

export function pendingSubscription(userId) {
  return db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
    .get(userId) || null;
}

export function listSubscriptions({ userId = null, status = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (userId != null) { where.push('s.user_id = ?'); args.push(Number(userId)); }
  if (status) { where.push('s.status = ?'); args.push(status); }
  return db.prepare(`SELECT s.*, u.username FROM subscriptions s JOIN users u ON u.id = s.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.id DESC LIMIT ?`).all(...args, Math.min(Math.max(Number(limit) || 200, 1), 500));
}

export function subscriptionStats() {
  const row = db.prepare(`SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now')) THEN 1 ELSE 0 END) AS active
    FROM subscriptions`).get();
  return { pending: row.pending || 0, active: row.active || 0 };
}

// ---------- 套餐 ----------
export function listPlans({ includeInactive = false } = {}) {
  return db.prepare(`SELECT * FROM plans ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort ASC, id ASC`).all();
}

export function getPlan(id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id) || null;
}

export function createPlan({ name, description = '', priceCents = 0, periodDays = 30, dailyChatLimit = 0, credits = 0, sort = 0, active = true }) {
  const r = db.prepare(`INSERT INTO plans (name, description, price_cents, period_days, daily_chat_limit, credits, sort, active)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    String(name).slice(0, 40), String(description).slice(0, 200),
    Math.max(0, Math.floor(Number(priceCents) || 0)),
    Math.min(Math.max(Math.floor(Number(periodDays) || 30), 1), 3650),
    Math.max(0, Math.floor(Number(dailyChatLimit) || 0)),
    Math.max(0, Math.floor(Number(credits) || 0)),
    Math.floor(Number(sort) || 0),
    active ? 1 : 0,
  );
  return getPlan(Number(r.lastInsertRowid));
}

export function updatePlan(id, patch = {}) {
  const cur = getPlan(id);
  if (!cur) return null;
  const next = {
    name: patch.name != null ? String(patch.name).slice(0, 40) : cur.name,
    description: patch.description != null ? String(patch.description).slice(0, 200) : cur.description,
    price_cents: patch.priceCents != null ? Math.max(0, Math.floor(Number(patch.priceCents) || 0)) : cur.price_cents,
    period_days: patch.periodDays != null ? Math.min(Math.max(Math.floor(Number(patch.periodDays) || 30), 1), 3650) : cur.period_days,
    daily_chat_limit: patch.dailyChatLimit != null ? Math.max(0, Math.floor(Number(patch.dailyChatLimit) || 0)) : cur.daily_chat_limit,
    credits: patch.credits != null ? Math.max(0, Math.floor(Number(patch.credits) || 0)) : cur.credits,
    sort: patch.sort != null ? Math.floor(Number(patch.sort) || 0) : cur.sort,
    active: patch.active != null ? (patch.active ? 1 : 0) : cur.active,
  };
  db.prepare(`UPDATE plans SET name=?, description=?, price_cents=?, period_days=?, daily_chat_limit=?, credits=?, sort=?, active=? WHERE id=?`)
    .run(next.name, next.description, next.price_cents, next.period_days, next.daily_chat_limit, next.credits, next.sort, next.active, id);
  return getPlan(id);
}

export function deletePlan(id) {
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
}

// ---------- 订阅流程 ----------
export function applySubscription(userId, planId, note = '') {
  const plan = getPlan(planId);
  if (!plan || !plan.active) return { ok: false, code: 'no_plan' };
  if (pendingSubscription(userId)) return { ok: false, code: 'pending_exists' };
  const r = db.prepare(`INSERT INTO subscriptions
      (user_id, plan_id, plan_name, status, price_cents, period_days, daily_chat_limit, credits, note)
    VALUES (?,?,?,'pending',?,?,?,?,?)`).run(
    userId, plan.id, plan.name, plan.price_cents, plan.period_days, plan.daily_chat_limit, plan.credits,
    String(note || '').slice(0, 200),
  );
  return { ok: true, id: Number(r.lastInsertRowid), plan };
}

// 审批通过：置为生效、按「快照」的周期算到期时间，并发放套餐额度
export function approveSubscription(id, actorName = '') {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!sub) return { ok: false, code: 'not_found' };
  if (sub.status === 'active') return { ok: false, code: 'already_active' };
  // 已有生效订阅时从原到期时间续期，避免「买两次反而更短」
  const cur = activeSubscription(sub.user_id);
  const base = cur && cur.expires_at ? cur.expires_at : null;
  const expiresRow = base
    ? db.prepare("SELECT datetime(?, ?) AS e").get(base, `+${sub.period_days} days`)
    : db.prepare("SELECT datetime('now', ?) AS e").get(`+${sub.period_days} days`);
  const note = [sub.note, actorName ? `审批：${actorName}` : ''].filter(Boolean).join(' · ');
  // 先撤掉旧的生效订阅，保证同一用户只有一条 active
  if (cur) db.prepare("UPDATE subscriptions SET status='canceled', updated_at = datetime('now') WHERE id = ?").run(cur.id);
  db.prepare(`UPDATE subscriptions SET status='active', started_at = COALESCE(started_at, datetime('now')),
      expires_at = ?, updated_at = datetime('now'), note = ? WHERE id = ?`).run(expiresRow.e, note, id);
  let balance = getUserCredits(sub.user_id);
  if (sub.credits > 0) {
    balance = addCredits(sub.user_id, sub.credits, 'subscribe', `套餐「${sub.plan_name}」发放 ${sub.credits} 次`);
  }
  return { ok: true, expires_at: expiresRow.e, credits: balance };
}

export function rejectSubscription(id, reason = '') {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!sub) return { ok: false, code: 'not_found' };
  if (sub.status !== 'pending') return { ok: false, code: 'not_pending' };
  db.prepare("UPDATE subscriptions SET status='rejected', updated_at = datetime('now'), note=? WHERE id=?")
    .run(String(reason || '').slice(0, 200), id);
  return { ok: true };
}

export function cancelSubscriptionById(id) {
  db.prepare("UPDATE subscriptions SET status='canceled', updated_at = datetime('now') WHERE id = ?").run(id);
}

// 生效上限与剩余额度：chat 路由与用户面板共用同一套判定，避免两处逻辑漂移
export function resolveQuota(userId) {
  const u = db.prepare('SELECT credits, daily_chat_limit FROM users WHERE id = ?').get(userId) || {};
  const sub = activeSubscription(userId);
  const siteLimit = numSetting('daily_chat_limit', 0);
  const userLimit = (u.daily_chat_limit === null || u.daily_chat_limit === undefined) ? null : Number(u.daily_chat_limit);
  const planLimit = sub ? Number(sub.daily_chat_limit || 0) : 0;
  const dailyLimit = userLimit !== null ? userLimit : (planLimit > 0 ? planLimit : siteLimit);
  const credits = (u.credits === null || u.credits === undefined) ? null : Number(u.credits);
  return {
    credits,
    unlimited: credits === null,
    daily_limit: dailyLimit,
    daily_limit_source: userLimit !== null ? 'user' : (planLimit > 0 ? 'plan' : 'site'),
    used_today: usageCountToday(userId),
    site_limit: siteLimit,
    plan_limit: planLimit,
    user_limit: userLimit,
    subscription: sub ? {
      id: sub.id, plan_id: sub.plan_id, plan_name: sub.plan_name,
      started_at: sub.started_at, expires_at: sub.expires_at,
      daily_chat_limit: sub.daily_chat_limit, credits: sub.credits,
    } : null,
  };
}
