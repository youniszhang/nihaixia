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

// First registered user becomes admin (or set ADMIN_USERNAME env to override).
export function isAdminUser(user) {
  if (!user) return false;
  if (process.env.ADMIN_USERNAME && user.username === process.env.ADMIN_USERNAME) return true;
  const adminId = getSetting('admin_user_id');
  return adminId != null && String(user.id) === String(adminId);
}

// ---------- users ----------
export function createUser(username, passwordHash) {
  const r = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
  return { id: r.lastInsertRowid, username };
}
export function findUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
export function findUserById(id) {
  return db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id);
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
export function countMessages(sessionId) {
  return db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(sessionId).c;
}
