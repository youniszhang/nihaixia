import fs from 'node:fs';
import path from 'node:path';
import { buildIndex, makeQueryVec, scoreChunk } from './indexer.js';
import config from '../config.js';

let INDEX = null;

export function loadKnowledge() {
  if (INDEX) return INDEX;
  const t0 = Date.now();
  INDEX = buildIndex(config.knowledgeDir);
  console.log(`[nihaixia] knowledge indexed: ${INDEX.chunks.length} chunks in ${Date.now() - t0}ms from ${config.knowledgeDir}`);
  return INDEX;
}

export function reloadKnowledge() {
  INDEX = null;
  return loadKnowledge();
}

const CATEGORY_PRIORITY = {
  skill: 1.3,
  cases: 1.15,
  modules: 1.1,
  'distilled-data': 1.05,
  xuanshu: 1.2, // 玄枢模块知识库（八字/奇门/紫微/塔罗等 reference 资料）
};

// 按模块过滤检索：
//   ragDirs: ['global']           → 原有全局知识库（中医：cases/modules/skill/...）
//   ragDirs: ['xuanshu']          → 玄枢模块知识库目录（knowledge/xuanshu/）
//   ragPrefix: 'bazi'             → 只取文件名以该前缀开头的块（如 bazi-*.md）
//                                  'master-' → 佛门各祖师目录（master-*/）
//   opts.boostDirs: ['xuanshu/master-huineng/'] → 命中的块加权（用户点名某位祖师时用）
export function retrieveForModule(query, mod, topK = 8, maxChars = 7000, opts = {}) {
  const idx = loadKnowledge();
  const qv = makeQueryVec(query);
  const wantXuanshu = (mod?.ragDirs || []).includes('xuanshu');
  const wantGlobal = (mod?.ragDirs || []).includes('global');
  const prefix = mod?.ragPrefix || '';
  const boostDirs = opts.boostDirs || [];
  const scored = [];
  for (const chunk of idx.chunks) {
    if (wantXuanshu && chunk.category === 'xuanshu') {
      // 祖师知识在子目录 xuanshu/master-<name>/…，用相对路径前缀匹配；
      // 其余模块是 xuanshu/<prefix>-*.md 扁平文件，用文件名匹配。
      const rel = chunk.file.replaceAll(path.sep, '/');
      if (prefix === 'master-') {
        if (!rel.includes('/master-') && !path.basename(rel).startsWith('master-')) continue;
      } else if (prefix && !path.basename(rel).startsWith(prefix)) {
        continue;
      }
    } else if (wantGlobal && chunk.category !== 'xuanshu') {
      // 全局知识库直通
    } else {
      continue;
    }
    let s = scoreChunk(qv, chunk);
    if (s > 0) {
      s *= CATEGORY_PRIORITY[chunk.category] || 1;
      // 点名加权：用户明确提到的祖师，其教法优先入上下文
      if (boostDirs.length) {
        const rel = chunk.file.replaceAll(path.sep, '/');
        if (boostDirs.some((d) => rel.startsWith(d))) s *= 2.5;
      }
      scored.push([s, chunk]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  const picked = [];
  let total = 0;
  for (const [s, chunk] of scored.slice(0, topK * 3)) {
    if (picked.length >= topK) break;
    const text = chunk.content.length > 1200 ? chunk.content.slice(0, 1200) + '…' : chunk.content;
    if (total + text.length > maxChars) break;
    picked.push({ ...chunk, content: text, score: Math.round(s) });
    total += text.length;
  }
  return picked;
}

export function retrieve(query, topK = 8, maxChars = 7000) {
  const idx = loadKnowledge();
  const qv = makeQueryVec(query);
  const scored = [];
  for (const chunk of idx.chunks) {
    let s = scoreChunk(qv, chunk);
    if (s > 0) {
      s *= CATEGORY_PRIORITY[chunk.category] || 1;
      scored.push([s, chunk]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  const picked = [];
  let total = 0;
  for (const [s, chunk] of scored.slice(0, topK * 3)) {
    if (picked.length >= topK) break;
    const text = chunk.content.length > 1200 ? chunk.content.slice(0, 1200) + '…' : chunk.content;
    if (total + text.length > maxChars) break;
    picked.push({ ...chunk, content: text, score: Math.round(s) });
    total += text.length;
  }
  return picked;
}
