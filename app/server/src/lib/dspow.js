/**
 * DeepSeek 网页版 PoW（工作量证明）求解器 —— 纯 Node，无需浏览器。
 *
 * 原理：DeepSeek 对 /api/v0/chat/completion 等接口要求请求头 x-ds-pow-response，
 * 内容为 base64(JSON)，其中 answer 是满足难度的随机数。算法为 DeepSeekHashV1，
 * 网页端用官方 WASM（sha3_wasm_bg）计算——这里直接复用同一个 WASM，
 * 调用约定照搬网页端胶水代码（wasm_solve(retptr, challenge, len, prefix, len, difficulty)）。
 *
 * WASM 首次使用时从 DeepSeek 静态 CDN 下载并缓存到数据目录；算法升级时可用
 * DS_POW_WASM_URL 覆盖地址。
 *
 * 说明：仅在「直连模式」（用 userToken 调网页版接口）下需要；浏览器通道不需要。
 */

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

let wasm = null;            // 实例化后的 exports
let loadPromise = null;     // 并发保护

function cacheFilePath() {
  const dir = path.dirname(config.dbPath);
  return path.join(dir, 'ds-pow.sha3.wasm');
}

async function loadWasmBytes() {
  const cached = cacheFilePath();
  try {
    const buf = fs.readFileSync(cached);
    if (buf.length > 1024) return buf;
  } catch { /* 未缓存 */ }
  const url = process.env.DS_POW_WASM_URL || DEFAULT_WASM_URL;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`PoW wasm 下载失败（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  try { fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, buf); } catch { /* 缓存失败不致命 */ }
  return buf;
}

export async function initPow() {
  if (wasm) return wasm;
  if (!loadPromise) {
    loadPromise = (async () => {
      const bytes = await loadWasmBytes();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      wasm = instance.exports;
      return wasm;
    })();
  }
  return loadPromise;
}

// 把 JS 字符串写入 wasm 内存（wasm-bindgen 的 passStringToWasm0 简化版，输入均为 ASCII 安全）
function passString(str) {
  const bytes = Buffer.from(str, 'utf8');
  const ptr = wasm.__wbindgen_export_0(bytes.length, 1) >>> 0;
  new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

/**
 * 解一道 PoW 题。
 *
 * 算法（逆向自网页端 worker，2026-09 已验证）：
 *   prefix = `${salt}_${expire_at}_`（注意结尾下划线）
 *   服务器的 challenge 就是 DeepSeekHashV1(prefix + answer) 的十六进制；
 *   wasm_solve 在 [0, difficulty) 内暴力搜索出 answer。
 *
 * @param {{challenge:string, salt:string, difficulty:number, expire_at:number|string, algorithm:string}} chal
 * @returns {number} answer
 */
export function solveChallenge(chal) {
  if (!wasm) throw new Error('PoW wasm 尚未初始化');
  if (chal.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`不支持的 PoW 算法：${chal.algorithm}`);
  }
  const prefix = `${chal.salt}_${chal.expire_at}_`;
  const c = passString(String(chal.challenge));
  const p = passString(prefix);
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    wasm.wasm_solve(retptr, c.ptr, c.len, p.ptr, p.len, Number(chal.difficulty));
    const dv = new DataView(wasm.memory.buffer);
    const status = dv.getInt32(retptr + 0, true);
    const answer = dv.getFloat64(retptr + 8, true);
    if (status === 0 || !Number.isFinite(answer)) {
      throw new Error('PoW 未找到解（挑战可能已过期，请重试）');
    }
    return answer;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

/** 构造 x-ds-pow-response 头的值（base64 的 JSON，字段与网页端一致） */
export function buildPowHeader(chal, answer, targetPath) {
  const payload = {
    algorithm: chal.algorithm,
    challenge: chal.challenge,
    salt: chal.salt,
    answer,
    signature: chal.signature,
    target_path: targetPath,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** 一站式：拿挑战 → 求解 → 返回可用的头值 */
export async function powHeaderFor(token, targetPath, fetchImpl = fetch) {
  const res = await fetchImpl('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: '*/*',
      origin: 'https://chat.deepseek.com',
      referer: 'https://chat.deepseek.com/',
    },
    body: JSON.stringify({ target_path: targetPath }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  const biz = j?.data?.biz_data;
  if (j?.data?.biz_code !== 0 || !biz?.challenge) {
    throw new Error(`获取 PoW 挑战失败：${j?.data?.biz_msg || j?.msg || '未知错误'}`);
  }
  await initPow();
  const answer = solveChallenge(biz.challenge);
  return buildPowHeader(biz.challenge, answer, targetPath);
}
