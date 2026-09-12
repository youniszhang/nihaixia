import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

let __dirnameSafe = '.';
try {
  __dirnameSafe = path.dirname(fileURLToPath(import.meta.url));
} catch { /* SEA/CJS bundle: import.meta unavailable → use cwd-relative defaults */ }

const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || path.join(__dirnameSafe, '../data/nihaixia.db'),
  knowledgeDir: process.env.KNOWLEDGE_DIR || path.resolve(__dirnameSafe, '../knowledge'),
  secret: process.env.APP_SECRET || crypto.randomBytes(32).toString('hex'),

  // LLM provider (OpenAI-compatible, e.g. DeepSeek)
  llm: {
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    model: process.env.LLM_MODEL || 'deepseek-chat',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 120000),
  },
};

if (!process.env.APP_SECRET) {
  console.warn('[nihaixia] ⚠️  APP_SECRET not set — using a random ephemeral secret. Sessions will reset on restart. Set APP_SECRET in production.');
}
if (!config.llm.apiKey) {
  console.warn('[nihaixia] ⚠️  LLM_API_KEY not set — chat will return an error. Set LLM_API_KEY in .env.');
}

export default config;
