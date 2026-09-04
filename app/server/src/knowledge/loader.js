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
};

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
