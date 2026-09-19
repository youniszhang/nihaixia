// 玄枢 · 容量保护（全局并发闸 + FIFO 排队）
//
// 为什么需要（2026-09-19 压测结论，单进程实测）：
//   并发 100/500 路流式对话：零失败，TTFB p95 ≤ 71ms；
//   并发 1000：事件循环 p99 冲到 218ms，TTFB p95 941ms，开始出现客户端超时；
//   并发 2000：约 18% 请求超时。
// 也就是说单进程的「同时生成」安全上限远低于 5000，必须主动限流排队，
// 把过载转化成「排队等待 + 明确预期」，而不是让所有人一起超时。
//
// 设计：
//   - 全局信号量：同一时刻最多 max_concurrent 路生成（默认 300，站点设置可调）
//   - FIFO 队列：闸满后进入公平排队（默认队列上限 500、单次等待上限 45s，均可调）
//   - 位置反馈：每秒回调一次「排位 + 预计等待」，chat 路由转成 SSE queue 事件给前端
//   - 到期/离场：等待超时或客户端断开都会让出队列位置
//   - 阈值持久化在 settings（capacity.*），管理员后台可调

import { getSetting, setSetting } from '../db.js';

const queue = []; // { userId, resolve, reject, enqueuedAt, timer, notify }
let active = 0;

export const CAPACITY_DEFAULTS = {
  max_concurrent: 300,
  queue_max: 500,
  queue_timeout_s: 45,
};

const num = (key, def) => {
  const raw = getSetting(key);
  if (raw === null || raw === undefined || String(raw).trim() === '') return def;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : def;
};

export function capacityThresholds() {
  return {
    max_concurrent: num('capacity_max_concurrent', CAPACITY_DEFAULTS.max_concurrent),
    queue_max: num('capacity_queue_max', CAPACITY_DEFAULTS.queue_max),
    queue_timeout_s: num('capacity_queue_timeout_s', CAPACITY_DEFAULTS.queue_timeout_s),
  };
}

export function setCapacityThresholds({ maxConcurrent, queueMax, queueTimeoutS } = {}) {
  if (maxConcurrent != null) {
    const n = Math.max(1, Math.min(5000, Math.floor(Number(maxConcurrent) || 0)));
    setSetting('capacity_max_concurrent', String(n));
  }
  if (queueMax != null) {
    const n = Math.max(0, Math.min(5000, Math.floor(Number(queueMax) || 0)));
    setSetting('capacity_queue_max', String(n));
  }
  if (queueTimeoutS != null) {
    const n = Math.max(3, Math.min(600, Math.floor(Number(queueTimeoutS) || 0)));
    setSetting('capacity_queue_timeout_s', String(n));
  }
  return capacityThresholds();
}

export function capacityStats() {
  const t = capacityThresholds();
  return { active, queued: queue.length, ...t };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pump() {
  const { max_concurrent } = capacityThresholds();
  while (active < max_concurrent && queue.length) {
    const waiter = queue.shift();
    clearTimeout(waiter.timer);
    active += 1;
    waiter.resolve();
  }
}

function removeFromQueue(entry) {
  const i = queue.indexOf(entry);
  if (i >= 0) queue.splice(i, 1);
}

// 预计等待（秒）：按排位与并发上限粗估，上游单次生成约 3~10s，取 6s/批
function estimateWaitSec(position, maxConcurrent) {
  return Math.ceil((position / Math.max(1, maxConcurrent)) * 6);
}

/**
 * 申请一个生成名额。
 * 返回 Promise：
 *   resolve(true)  → 拿到名额（记得 finally 里 release()）
 *   reject(Error)  → code: 'queue_full'（连队列都满了）| 'queue_timeout'（排队超时）| 'aborted'（客户端先走了）
 * onQueued(position, estWaitSec) 在排队期间每秒回调一次，用于 SSE 进度反馈。
 */
export async function acquireGenerationSlot(userId, { onQueued, signal } = {}) {
  const t = capacityThresholds();
  if (active < t.max_concurrent && queue.length === 0) {
    active += 1;
    return true;
  }
  if (queue.length >= t.queue_max) {
    const e = new Error('当前使用人数已达瞬时上限，请稍后再试');
    e.code = 'queue_full';
    throw e;
  }

  const entry = { userId, enqueuedAt: Date.now(), timer: null, resolve: null, reject: null };
  const promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });
  queue.push(entry);

  const onAbort = () => {
    removeFromQueue(entry);
    const e = new Error('客户端已取消');
    e.code = 'aborted';
    entry.reject?.(e);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  entry.timer = setTimeout(() => {
    removeFromQueue(entry);
    signal?.removeEventListener('abort', onAbort);
    const e = new Error(`当前使用人数较多，排队 ${t.queue_timeout_s} 秒仍未轮到，请稍后重试`);
    e.code = 'queue_timeout';
    e.retryAfterS = 10;
    entry.reject?.(e);
  }, t.queue_timeout_s * 1000);

  // 位置反馈：每秒广播一次
  const notify = async () => {
    if (signal?.aborted) return;
    const pos = queue.indexOf(entry);
    if (pos >= 0) onQueued?.(pos + 1, estimateWaitSec(pos + 1, t.max_concurrent));
    if (queue.includes(entry)) setTimeout(notify, 1000);
  };
  setTimeout(notify, 50);

  try {
    await promise;
    signal?.removeEventListener('abort', onAbort);
    // 拿到名额时如果客户端已经断开，立刻释放名额并报 aborted
    if (signal?.aborted) {
      release();
      const e = new Error('客户端已取消');
      e.code = 'aborted';
      throw e;
    }
    return true;
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    // 队列里的人离场后要补位推进
    pump();
    throw e;
  }
}

export function release() {
  active = Math.max(0, active - 1);
  pump();
}
