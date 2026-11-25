// 玄枢 · 学习练习 API
//
//   GET  /api/study/:module                    → 章节列表 + 学习统计
//   POST /api/study/:module/generate           → AI 生成章节（SSE 流式，入库前白名单净化）
//   GET  /api/study/chapter/:id                → 章节详情（HTML 正文）
//   DELETE /api/study/chapter/:id              → 删除章节（生成者或管理员；错题快照保留）
//   POST /api/study/:module/quiz               → AI 出题（题库落库，返回不带答案的题目）
//   GET  /api/study/:module/quiz/:chapterId    → 重取该章题目（刷新/重进，不带答案）
//   POST /api/study/:module/submit             → 提交答案（服务端判题 + 错题集联动）
//   GET  /api/study/:module/wrongs             → 错题集（?all=1 含已移出的历史）
//   POST /api/study/:module/wrongs/submit      → 错题重练判题（同样走错题集联动）
//
// 权限：模块级（userHasModule）——学习内容挂在模块下，未开通该模块即 403。
// 计费：生成章节与出题各扣 1 次额度并过容量闸（与 chat 同一套闸门，防止刷接口烧 token）。
// 安全：章节 HTML 经 sanitizeStudyHtml 白名单净化后入库；题目 JSON 服务端严格校验后落库。

import {
  getSetting, resolveQuota, consumeCredit, userHasModule, logUsage,
  createStudyChapter, getStudyChapter, listStudyChapters, deleteStudyChapter,
  replaceStudyQuestions, listStudyQuestions, getStudyQuestion,
  recordStudyAttempt, listStudyWrongs, studyStats,
  fillStudyChapter, seedStudySyllabus,
} from '../db.js';
import * as dbModule from '../db.js';
import { getModule } from '../modules/registry.js';
import { retrieve, retrieveForModule } from '../knowledge/loader.js';
import { buildRagBlock } from '../knowledge/system-prompt.js';
import { streamChat } from '../llm.js';
import { sanitizeStudyHtml } from '../lib/sanitizeHtml.js';
import { chapterPrompt, quizPrompt, syllabusTopics } from '../lib/studyPrompts.js';
import { errorRef } from '../lib/redact.js';
import { sendError, clamp } from '../lib/validate.js';
import { acquireGenerationSlot, release as releaseCapacity } from '../lib/capacity.js';
import config from '../config.js';

function sse(res, data) {
  res.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

// —— 题目 JSON 解析与校验（模型输出不可信，逐题校验） ——
function parseQuizJson(raw) {
  let text = String(raw || '').trim();
  // 模型常给 ```json 围栏，兼容剥掉
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  // 只取第一个 [ 到最后一个 ] 之间的内容（防前后搀话）
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    return arr;
  } catch {
    return null;
  }
}

const TYPE_DEF = {
  single: { minOptions: 2, maxOptions: 6, multi: false },
  multi: { minOptions: 3, maxOptions: 6, multi: true },
  tf: { minOptions: 2, maxOptions: 2, multi: false },
};

function validateQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const type = TYPE_DEF[q.type] ? q.type : null;
  if (!type) return null;
  const stem = String(q.stem || '').trim();
  if (!stem || stem.length > 300) return null;
  const options = Array.isArray(q.options) ? q.options.map((o) => String(o).slice(0, 200)) : null;
  if (!options || options.length < TYPE_DEF[type].minOptions || options.length > TYPE_DEF[type].maxOptions) return null;
  const answer = String(q.answer || '').trim();
  if (!answer || answer.length > 20) return null;
  const explanation = String(q.explanation || '').slice(0, 600);
  return { type, stem, options, answer, explanation };
}

// 判题：客观比对（答案串 → 字母集合比对）
function judgeAnswer(type, correct, userAnswer) {
  const norm = (s) => String(s || '').split(/[,，、\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean).sort();
  const a = norm(correct);
  const b = norm(userAnswer);
  if (!b.length) return false;
  if (type === 'multi') {
    if (a.length !== b.length) return false;
    return a.every((x, i) => x === b[i]);
  }
  return String(correct).trim().toUpperCase() === String(userAnswer).trim().toUpperCase();
}

// RAG 检索（学习内容与聊天共用同一套模块知识库）。
// 查询串拼上模块名与 tagline：目录标题常是「入门/什么是」这类泛化词，
// 光靠 topic 检索会 0 命中（tarot 实测），补模块核心术语保证召回。
function studyRagBlock(moduleId, mod, topic) {
  const query = `${mod.name} ${mod.tagline} ${topic}`;
  const chunks = moduleId === 'tcm'
    ? retrieve(query, 8)
    : retrieveForModule(query, mod, 8, 7000);
  return buildRagBlock(chunks);
}

// 通用：LLM 配置（DB 设置优先于 .env，与 chat.js 一致）
function llmConfig() {
  return {
    apiKey: getSetting('llm_api_key') || config.llm.apiKey,
    baseUrl: getSetting('llm_base_url') || config.llm.baseUrl,
    model: getSetting('llm_model') || config.llm.model,
  };
}

// 下发给前端的题目（剥离 answer/explanation）
function publicQuestion(row, i) {
  return { id: row.id, index: i, type: row.type, stem: row.stem, options: JSON.parse(row.options_json || '[]') };
}

export default async function studyRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] };
  const rateOpts = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  // 模块校验（返回 null 表示已回错）
  function checkModule(req, reply) {
    const moduleId = clamp(String(req.params.module || '').trim(), 20);
    const mod = getModule(moduleId);
    if (!mod) {
      sendError(reply, 'bad_module', '未知模块', 400);
      return null;
    }
    if (!userHasModule(req.user, moduleId)) {
      sendError(reply, 'module_locked', `「${mod.name}」模块未开通，无法使用学习中心。`, 403);
      return null;
    }
    return mod;
  }

  // 额度预检（生成类接口共用）
  function checkQuota(req, reply) {
    const quota = resolveQuota(req.user.id);
    if (!quota.unlimited && quota.credits <= 0) {
      sendError(reply, 'no_credits', '额度已用完。可在「每日签到」中领取额度，或开通订阅套餐后继续。', 402);
      return null;
    }
    if (quota.daily_limit > 0 && quota.used_today >= quota.daily_limit) {
      sendError(reply, 'daily_limit', `今日使用次数已达上限（每天 ${quota.daily_limit} 次），请明天再来。`, 429);
      return null;
    }
    return quota;
  }

  function chargeCredit(userId, note) {
    try { consumeCredit(userId, note); } catch { /* 记账失败不影响功能 */ }
  }

  function logStudyUsage(userId, moduleId, promptChars, completionChars) {
    try {
      logUsage({ userId, sessionId: null, provider: 'api', model: getSetting('llm_model') || config.llm.model, promptChars, completionChars });
    } catch { /* ignore */ }
  }

  // —— 章节列表 + 统计（首次访问自动铺内置课程目录） ——
  fastify.get('/:module', auth, async (req, reply) => {
    const mod = checkModule(req, reply);
    if (!mod) return;
    // 内置目录：第一次有人打开学习中心时铺占位章节（幂等，只补缺）
    try {
      const topics = syllabusTopics(mod.id);
      if (topics.length) {
        seedStudySyllabus(mod.id, topics, req.user.id);
      }
    } catch (e) {
      fastify.log.warn({ err: String(e) }, 'study syllabus seed failed');
    }
    const chapters = listStudyChapters(mod.id);
    return {
      module: { id: mod.id, name: mod.name, tagline: mod.tagline, icon: mod.icon, color: mod.color },
      chapters,
      stats: studyStats(req.user.id, mod.id),
    };
  });

  // —— 生成章节（SSE 流式：生成过程可见，结束后返回净化入库的章节） ——
  fastify.post('/:module/generate', { preHandler: [fastify.authenticate], ...rateOpts, bodyLimit: 1024 * 64 }, async (req, reply) => {
    const mod = checkModule(req, reply);
    if (!mod) return;
    const quota = checkQuota(req, reply);
    if (!quota) return;

    const topic = clamp((req.body?.topic || '').trim(), 120) || mod.name;
    // 两种生成模式：
    //   ① chapter_id 指向目录占位章节 → 内容回填该行（内置课程「点开时生成」）
    //   ② 无 chapter_id → 用户自定义话题，新插一行
    const fillId = Number(req.body?.chapter_id || 0);
    let target = null;
    if (fillId) {
      target = getStudyChapter(fillId);
      if (!target || target.module_id !== mod.id) {
        sse(reply, { type: 'error', message: '章节不存在。' });
        reply.raw.end();
        return;
      }
      // 已有内容 → 幂等直接返回（不重复生成、不扣额度）
      if (target.content_html && target.content_html.length > 100) {
        sse(reply, { type: 'done', chapter: target });
        reply.raw.end();
        return;
      }
    }
    const ragBlock = studyRagBlock(mod.id, mod, topic);
    const prompt = chapterPrompt(mod.name, topic, ragBlock);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    const abortController = new AbortController();
    req.raw.on('close', () => { clearInterval(heartbeat); abortController.abort(); });

    let capacityTicket = null;
    try {
      capacityTicket = await acquireGenerationSlot(req.user.id, {
        signal: abortController.signal,
        onQueued: (position, estWaitSec) => sse(reply, { type: 'queue', position, est_wait_s: estWaitSec }),
      });
    } catch (capErr) {
      clearInterval(heartbeat);
      sse(reply, { type: 'error', code: capErr.code || 'busy', message: '服务器繁忙，请稍后再试。' });
      reply.raw.end();
      return;
    }

    let full = '';
    try {
      sse(reply, { type: 'start' });
      const messages = [{ role: 'user', content: prompt }];
      for await (const delta of streamChat(messages, abortController.signal, llmConfig())) {
        full += delta;
        sse(reply, { type: 'delta', text: delta });
      }
      const safeHtml = sanitizeStudyHtml(full);
      if (!safeHtml || safeHtml.length < 100) {
        sse(reply, { type: 'error', message: '本次生成内容为空或过短，请换个话题重试。' });
        return;
      }
      const chapter = target
        ? fillStudyChapter(target.id, safeHtml)   // 回填目录占位行
        : createStudyChapter({ userId: req.user.id, moduleId: mod.id, title: topic, topic, contentHtml: safeHtml });
      chargeCredit(req.user.id, `学习章节生成 · ${mod.name}`);
      logStudyUsage(req.user.id, mod.id, prompt.length, full.length);
      sse(reply, { type: 'done', chapter });
    } catch (err) {
      const ref = errorRef();
      fastify.log.error({ err: String(err), ref, userId: req.user.id, module: mod.id }, 'study chapter generation failed');
      const msg = err.code === 'no_api_key' ? '未配置模型通道：请联系管理员在「模型设置」中配置。'
        : err.code === 'auth' ? '模型服务鉴权失败：请联系管理员更新 API Key。'
        : err.code === 'rate_limit' ? '模型服务繁忙，请稍后重试。'
        : err.code === 'model_not_found' ? '当前配置的模型名在上游已不可用。请管理员在「模型设置」中更换模型。'
        : `生成失败（错误编号 ${ref}），请稍后再试。`;
      sse(reply, { type: 'error', message: msg });
    } finally {
      clearInterval(heartbeat);
      if (capacityTicket) releaseCapacity();
      reply.raw.end();
    }
  });

  // —— 章节详情 ——
  fastify.get('/chapter/:id', auth, async (req, reply) => {
    const chapter = getStudyChapter(Number(req.params.id));
    if (!chapter) return sendError(reply, 'not_found', '章节不存在', 404);
    const mod = getModule(chapter.module_id);
    if (!mod || !userHasModule(req.user, chapter.module_id)) {
      return sendError(reply, 'module_locked', '该章节所属模块未开通。', 403);
    }
    return { chapter };
  });

  // —— 删除章节（仅生成者或管理员） ——
  fastify.delete('/chapter/:id', auth, async (req, reply) => {
    const chapter = getStudyChapter(Number(req.params.id));
    if (!chapter) return sendError(reply, 'not_found', '章节不存在', 404);
    const isOwner = chapter.user_id === req.user.id;
    const isAdmin = Boolean(req.user.is_admin);
    if (!isOwner && !isAdmin) return sendError(reply, 'forbidden', '只有章节创建者或管理员可以删除。', 403);
    deleteStudyChapter(chapter.id);
    return { ok: true };
  });

  // —— 出题（题库落库，返回不带答案的题目） ——
  fastify.post('/:module/quiz', { preHandler: [fastify.authenticate], ...rateOpts, bodyLimit: 1024 * 64 }, async (req, reply) => {
    const mod = checkModule(req, reply);
    if (!mod) return;
    const quota = checkQuota(req, reply);
    if (!quota) return;

    const chapterId = Number(req.body?.chapter_id || 0);
    const chapter = chapterId ? getStudyChapter(chapterId) : null;
    if (!chapter || chapter.module_id !== mod.id) {
      return sendError(reply, 'bad_chapter', '请先生成或选择一个章节再出题。', 400);
    }

    const count = Math.max(3, Math.min(Number(req.body?.count) || 5, 12));
    const ragBlock = studyRagBlock(mod.id, mod, chapter.topic || chapter.title);
    const prompt = quizPrompt(mod.name, chapter.topic || chapter.title, ragBlock, count);

    let capacityTicket = null;
    try {
      capacityTicket = await acquireGenerationSlot(req.user.id, {});
    } catch (capErr) {
      return sendError(reply, 'busy', '服务器繁忙，请稍后再试。', 503);
    }

    try {
      let full = '';
      for await (const delta of streamChat([{ role: 'user', content: prompt }], null, llmConfig())) {
        full += delta;
      }
      const raw = parseQuizJson(full);
      if (!raw) {
        return sendError(reply, 'quiz_parse_failed', '题目生成失败（模型输出不合规），请重试。', 502);
      }
      const questions = raw.map(validateQuestion).filter(Boolean).slice(0, count);
      if (questions.length < 3) {
        return sendError(reply, 'quiz_parse_failed', '有效题目不足 3 道，请重试。', 502);
      }
      // 落库（整章替换）；错题集里旧题的快照保留（question_id 置 0）
      const ids = replaceStudyQuestions({ chapterId: chapter.id, moduleId: mod.id, questions });
      chargeCredit(req.user.id, `学习测验出题 · ${mod.name}`);
      logStudyUsage(req.user.id, mod.id, prompt.length, full.length);
      const rows = listStudyQuestions(chapter.id);
      return {
        chapter_id: chapter.id,
        questions: rows.map(publicQuestion),
      };
    } catch (err) {
      const ref = errorRef();
      fastify.log.error({ err: String(err), ref, userId: req.user.id, module: mod.id }, 'study quiz generation failed');
      return sendError(reply, 'quiz_failed', `出题失败（错误编号 ${ref}），请稍后再试。`, 502);
    } finally {
      if (capacityTicket) releaseCapacity();
    }
  });

  // —— 重取题目（答题界面刷新/重进用；不带答案） ——
  fastify.get('/:module/quiz/:chapterId', auth, async (req, reply) => {
    const mod = checkModule(req, reply);
    if (!mod) return;
    const chapterId = Number(req.params.chapterId);
    const rows = listStudyQuestions(chapterId);
    if (!rows.length) return sendError(reply, 'not_found', '本章暂无题目，请先生成测验。', 404);
    return { chapter_id: chapterId, questions: rows.map(publicQuestion) };
  });

  // —— 提交答案（服务端判题 + 错题集联动） ——
  fastify.post('/:module/submit', { preHandler: [fastify.authenticate], ...rateOpts, bodyLimit: 1024 * 64 }, async (req, reply) => {
    const mod = checkModule(req, reply);
    if (!mod) return;
    const chapterId = Number(req.body?.chapter_id || 0);
    const answers = req.body?.answers;
    const chapter = chapterId ? getStudyChapter(chapterId) : null;
    if (!chapter || chapter.module_id !== mod.id) {
      return sendError(reply, 'not_found', '题目已失效（章节不存在），请刷新后重试。', 404);
    }
    const rows = listStudyQuestions(chapterId);
    if (!rows.length) return sendError(reply, 'not_found', '本章暂无题目，请先生成测验。', 404);
    if (!Array.isArray(answers)) return sendError(reply, 'bad_request', '缺少答案', 400);

    const results = [];
    let correctCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const q = rows[i];
      const userAnswer = String(answers?.[i] ?? '').slice(0, 200);
      const isCorrect = judgeAnswer(q.type, q.answer, userAnswer);
      if (isCorrect) correctCount++;
      recordStudyAttempt({
        userId: req.user.id,
        question: q,
        userAnswer,
        isCorrect,
        moduleId: mod.id,
      });
      results.push({ id: q.id, index: i, correct: isCorrect, answer: q.answer, explanation: q.explanation });
    }
    return {
      chapter_id: chapterId,
      total: rows.length,
      correct: correctCount,
      results,
      stats: studyStats(req.user.id, mod.id),
    };
  });

  // —— 错题集 ——
  fastify.get('/:module/wrongs', auth, async (req, reply) => {
    const mod = checkModule(req, reply);
    if (!mod) return;
    const includeRemoved = req.query?.all === '1';
    const wrongs = listStudyWrongs(req.user.id, mod.id, { includeRemoved });
    return { wrongs, stats: studyStats(req.user.id, mod.id) };
  });

  // —— 错题重练：把在集错题按快照判题（连对 2 次自动移出） ——
  fastify.post('/:module/wrongs/submit', { preHandler: [fastify.authenticate], ...rateOpts, bodyLimit: 1024 * 64 }, async (req, reply) => {
    const mod = checkModule(req, reply);
    if (!mod) return;
    const wrongs = listStudyWrongs(req.user.id, mod.id, {});
    if (!wrongs.length) return sendError(reply, 'empty', '错题集是空的。', 400);
    const answers = req.body?.answers;
    if (!Array.isArray(answers)) return sendError(reply, 'bad_request', '缺少答案', 400);

    const results = [];
    let correctCount = 0;
    for (let i = 0; i < wrongs.length; i++) {
      const w = wrongs[i];
      const userAnswer = String(answers[i] ?? '').slice(0, 200);
      const isCorrect = judgeAnswer(w.type, w.answer, userAnswer);
      if (isCorrect) correctCount++;
      // question_id 为正 = 题目仍在库（正常题重练）；为负 = 章节已删的快照题
      const q = w.question_id > 0 ? getStudyQuestion(w.question_id) : null;
      if (q) {
        recordStudyAttempt({ userId: req.user.id, question: q, userAnswer, isCorrect, moduleId: mod.id });
      } else {
        // 快照题：直接维护错题集状态（不写 attempts——题目实体已删）
        recordWrongOnly({ userId: req.user.id, wrongRow: w, userAnswer, isCorrect });
      }
      results.push({
        id: w.question_id,
        index: i,
        correct: isCorrect,
        answer: w.answer,
        explanation: w.explanation,
        removed: isCorrect && Number(w.streak || 0) + 1 >= 2,
      });
    }
    return {
      total: wrongs.length,
      correct: correctCount,
      results,
      stats: studyStats(req.user.id, mod.id),
    };
  });
}

// 快照判题（章节已删的错题）：不走 attempts，直接维护错题集状态
function recordWrongOnly({ userId, wrongRow, userAnswer, isCorrect }) {
  if (!isCorrect) {
    dbModule.db.prepare(`UPDATE study_wrongs SET user_answer = ?, streak = 0, removed = 0, updated_at = datetime('now')
      WHERE user_id = ? AND question_id = ?`).run(String(userAnswer ?? ''), userId, wrongRow.question_id);
  } else {
    const streak = Number(wrongRow.streak || 0) + 1;
    if (streak >= 2) {
      dbModule.db.prepare(`UPDATE study_wrongs SET streak = 0, removed = 1, updated_at = datetime('now')
        WHERE user_id = ? AND question_id = ?`).run(userId, wrongRow.question_id);
    } else {
      dbModule.db.prepare(`UPDATE study_wrongs SET streak = ?, updated_at = datetime('now')
        WHERE user_id = ? AND question_id = ?`).run(streak, userId, wrongRow.question_id);
    }
  }
}
