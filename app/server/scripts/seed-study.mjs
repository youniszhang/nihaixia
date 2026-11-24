#!/usr/bin/env node
// 学习中心 · 课程预生成脚本
//
// 用途：把内置课程大纲（STUDY_SYLLABUS.tcm）的整套章节用真实 LLM 一次性生成入库，
// 用户打开学习中心即读零等待。可反复跑（幂等：已有内容的章节跳过）。
//
// 用法（在 app/server 下）：
//   DB_PATH=/path/to/nihaixia.db node --env-file=../.env scripts/seed-study.mjs
//   DB_PATH=... node scripts/seed-study.mjs --module tcm --limit 5 --dry   # 试跑 5 章
//
// 说明：
//   - LLM 配置优先级与线上一致：DB settings（llm_*）> .env；
//   - 每章之间间隔 1s，避免打爆上游限流；
//   - 生成失败重试 1 次，再失败就跳过（下次跑脚本再补）；
//   - 扣额度/容量闸不适用（离线脚本，不模拟用户行为）。

import path from 'node:path';
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const MODULE_ID = String(args.module || 'tcm');

// —— 以子进程方式借服务端模块链（esbuild-free，直接 node ESM）——
// db.js 顶层建表 + seedStudySyllabus 幂等，加载即生效。
process.env.DB_PATH = process.env.DB_PATH || path.resolve('data/nihaixia.db');
const DB_PATH = process.env.DB_PATH;
if (!fs.existsSync(DB_PATH)) {
  console.error(`[seed-study] DB 不存在: ${DB_PATH}（先启动一次服务让建库，或检查 DB_PATH）`);
  process.exit(1);
}

const { db, seedStudySyllabus, getStudyChapter, fillStudyChapter } = await import('../src/db.js');
const { syllabusTopics, chapterPrompt } = await import('../src/lib/studyPrompts.js');
const { getModule } = await import('../src/modules/registry.js');
const { retrieve, retrieveForModule } = await import('../src/knowledge/loader.js');
const { buildRagBlock } = await import('../src/knowledge/system-prompt.js');
const { sanitizeStudyHtml } = await import('../src/lib/sanitizeHtml.js');
const { streamChat } = await import('../src/llm.js');

// 管理员用户 id（生成者挂名）：取库里第一个管理员，找不到就用 ADMIN_USERNAME 或第一个用户
const { getSetting } = await import('../src/db.js');
function pickOwnerUserId() {
  const adminName = (process.env.ADMIN_USERNAME || '').trim();
  if (adminName) {
    const u = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(adminName);
    if (u) return u.id;
  }
  const any = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  return any ? any.id : 1;
}

// LLM 配置（DB settings > env）
function llmConfig() {
  return {
    apiKey: getSetting('llm_api_key') || process.env.LLM_API_KEY || '',
    baseUrl: getSetting('llm_base_url') || process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    model: getSetting('llm_model') || process.env.LLM_MODEL || 'deepseek-chat',
  };
}

const topics = syllabusTopics(MODULE_ID);
if (!topics.length) {
  console.error(`[seed-study] 模块 ${MODULE_ID} 没有内置课程大纲（STUDY_SYLLABUS 里是空数组）`);
  process.exit(1);
}
const mod = getModule(MODULE_ID);
const cfg = llmConfig();
if (!cfg.apiKey) {
  console.error('[seed-study] LLM API Key 未配置（DB settings 与 .env 都没有）');
  process.exit(1);
}

const limit = Number(args.limit) || 0;
const list = limit > 0 ? topics.slice(0, limit) : topics;
console.log(`[seed-study] 模块=${MODULE_ID}（${mod.name}）共 ${topics.length} 章，本次处理 ${list.length} 章`);
console.log(`[seed-study] LLM: ${cfg.baseUrl} · ${cfg.model}`);

// 1. 铺目录（幂等）
const ownerId = pickOwnerUserId();
const added = seedStudySyllabus(MODULE_ID, topics, ownerId);
console.log(`[seed-study] 目录占位新增 ${added} 行（已存在的跳过）`);

// 2. 逐章生成回填
const rows = db.prepare(`SELECT id, topic, content_html FROM study_chapters WHERE module_id = ? ORDER BY id ASC`).all(MODULE_ID);
const byTopic = new Map(rows.map((r) => [r.topic, r]));

let done = 0, skipped = 0, failed = 0;
for (const topic of list) {
  const row = byTopic.get(topic);
  if (!row) { console.log(`  ?? ${topic}（目录行缺失，跳过）`); failed++; continue; }
  if (row.content_html && row.content_html.length > 100) {
    console.log(`  -- ${topic}（已有内容，跳过）`);
    skipped++;
    continue;
  }
  if (args.dry) { console.log(`  DRY ${topic}`); done++; continue; }

  const chunks = MODULE_ID === 'tcm'
    ? retrieve(`${mod.name} ${mod.tagline} ${topic}`, 8)
    : retrieveForModule(`${mod.name} ${mod.tagline} ${topic}`, mod, 8, 7000);
  const prompt = chapterPrompt(mod.name, topic, buildRagBlock(chunks));

  let html = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let full = '';
      for await (const delta of streamChat([{ role: 'user', content: prompt }], null, cfg)) {
        full += delta;
      }
      const safe = sanitizeStudyHtml(full);
      if (safe && safe.length >= 100) { html = safe; break; }
      console.log(`  !! ${topic} 第 ${attempt} 次输出过短（${safe.length} 字符），重试`);
    } catch (e) {
      console.log(`  !! ${topic} 第 ${attempt} 次失败：${String(e.message || e).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (html) {
    fillStudyChapter(row.id, html);
    done++;
    console.log(`  ok ${topic}（${Math.round(html.length / 1000)}k 字符）`);
  } else {
    failed++;
    console.log(`  XX ${topic}（生成失败，下次再补）`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`\n[seed-study] 完成：生成 ${done} / 跳过 ${skipped} / 失败 ${failed}`);
process.exit(failed ? 2 : 0);
