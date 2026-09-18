// 登录失败节流（内存态，单实例足够）
//
// 背景（2026-09-18 实测复现）：代理头可伪造时，仅按 req.ip 限流会被
// 「每次换一个 X-Forwarded-For」完全绕过（40 次爆破 0 次被拦）。
// 因此除 IP 维度外，再加一层「账号维度」的失败节流：
//   同一账号连续失败到阈值后，锁定一段时间并逐次拉长（指数退避，带上限）。
//
// 只记失败、成功即清零；状态放内存（进程重启即重置，可接受）。

const MAX_ENTRIES = 5000; // 防止被海量随机账号撑爆内存

const attempts = new Map(); // key -> { fails, lockedUntil, firstAt }

function prune() {
  if (attempts.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of attempts) {
    if (v.lockedUntil < now && now - v.firstAt > 3600_000) attempts.delete(k);
    if (attempts.size <= MAX_ENTRIES) break;
  }
  // 仍超限：按插入顺序丢最旧的
  while (attempts.size > MAX_ENTRIES) {
    const oldest = attempts.keys().next().value;
    attempts.delete(oldest);
  }
}

const THRESHOLD = Number(process.env.LOGIN_FAIL_THRESHOLD || 5);      // 连续失败多少次开始锁
const BASE_LOCK_MS = Number(process.env.LOGIN_LOCK_BASE_MS || 30_000); // 首次锁定时长
const MAX_LOCK_MS = Number(process.env.LOGIN_LOCK_MAX_MS || 900_000);  // 最长 15 分钟

// 锁定中返回剩余毫秒数，否则 0
export function loginLockRemaining(key) {
  const rec = attempts.get(key);
  if (!rec || !rec.lockedUntil) return 0;
  const left = rec.lockedUntil - Date.now();
  if (left <= 0) { rec.lockedUntil = 0; return 0; }
  return left;
}

export function recordLoginFailure(key) {
  prune();
  const now = Date.now();
  const rec = attempts.get(key) || { fails: 0, lockedUntil: 0, firstAt: now };
  rec.fails += 1;
  if (rec.fails >= THRESHOLD) {
    // 5 次 → 30s，6 次 → 60s，7 次 → 2min… 上限 15 分钟
    const step = rec.fails - THRESHOLD;
    const lock = Math.min(BASE_LOCK_MS * 2 ** step, MAX_LOCK_MS);
    rec.lockedUntil = now + lock;
  }
  attempts.set(key, rec);
  return rec.fails;
}

export function clearLoginFailures(key) {
  attempts.delete(key);
}

// 测试/运维用：当前被锁的条目数
export function throttleStats() {
  const now = Date.now();
  let locked = 0;
  for (const v of attempts.values()) if (v.lockedUntil > now) locked++;
  return { tracked: attempts.size, locked };
}
