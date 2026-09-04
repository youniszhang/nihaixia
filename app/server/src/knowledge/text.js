// Text tokenization & CJK bigram helpers shared by indexer and retriever.

export function tokenize(text) {
  if (!text) return [];
  // latin words + numbers
  const tokens = (text.toLowerCase().match(/[a-z0-9_]{2,}/g) || []);
  return tokens;
}

export function bigrams(text) {
  const out = [];
  const chars = (text || '').replace(/\s+/g, '');
  for (let i = 0; i < chars.length - 1; i++) {
    out.push(chars.slice(i, i + 2));
  }
  return out;
}

// Strip common particles that add noise to retrieval (small stopword list)
const STOP = new Set(['的', '了', '呢', '嘛', '啊', '呢', '么', '和', '是', '在', '我', '你', '这', '那', '有', '就', '都', '与', '及', '或']);

export function isNoiseChar(c) {
  return STOP.has(c);
}
