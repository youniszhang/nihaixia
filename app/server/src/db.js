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
// 优先级：数据库设置（后台在线切换）> REGISTRATION_ENABLED 环境变量 > 默认开放
// 默认开放是为兼容既有部署；管理员可在后台「站点设置」关闭。
export function isRegistrationOpen() {
  const stored = getSetting('registration_enabled');
  if (stored !== null) return stored !== 'false';
  const env = (process.env.REGISTRATION_ENABLED || '').trim().toLowerCase();
  if (env === 'false' || env === '0' || env === 'off') return false;
  if (env === 'true' || env === '1' || env === 'on') return true;
  return true;
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
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
      (SELECT COUNT(*) FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.user_id = u.id AND m.role = 'user') AS question_count,
      (SELECT COUNT(*) FROM usage_log l WHERE l.user_id = u.id) AS call_count
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
