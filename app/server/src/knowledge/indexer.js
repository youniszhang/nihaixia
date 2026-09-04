import fs from 'node:fs';
import path from 'node:path';
import { tokenize, bigrams } from './text.js';

// Recursively index all .md files under knowledge root into chunks (~350 chars)
export function buildIndex(rootDir) {
  const chunks = [];
  const files = [];
  walk(rootDir, files);
  for (const file of files) {
    const rel = path.relative(rootDir, file);
    const category = rel.split(path.sep)[0] || 'misc';
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let heading = '';
    let buf = [];
    const push = () => {
      const content = buf.join('\n').trim();
      if (content.length < 20) { buf = []; return; }
      chunks.push({ file: rel, category, heading, content, vec: null });
      buf = [];
    };
    for (const line of text.split('\n')) {
      const m = line.match(/^(#{1,4})\s+(.*)/);
      if (m) { push(); heading = m[2].trim(); continue; }
      buf.push(line);
      if (buf.join('\n').length > 380) push();
    }
    push();
  }
  // Build token vectors
  for (const c of chunks) {
    c.vec = vectorize(c.heading + ' ' + c.content);
  }
  return { chunks };
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
}

function vectorize(text) {
  const vec = new Map();
  const chars = text.replace(/\s+/g, '');
  // char bigrams for CJK robustness
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars.slice(i, i + 2);
    vec.set(g, (vec.get(g) || 0) + 1);
  }
  // latin tokens
  for (const t of tokenize(text)) {
    vec.set(t, (vec.get(t) || 0) + 2);
  }
  return vec;
}

export function scoreChunk(queryTerms, chunk) {
  if (!chunk.vec) return 0;
  let score = 0;
  for (const [term] of queryTerms) {
    if (term.length === 1) continue; // skip single CJK chars for precision
    const v = chunk.vec.get(term);
    if (v) score += Math.min(v, 4) + (chunk.heading.includes(term) ? 2 : 0);
  }
  return score;
}

export function makeQueryVec(query) {
  const q = new Map();
  const chars = query.replace(/\s+/g, '');
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars.slice(i, i + 2);
    q.set(g, (q.get(g) || 0) + 1);
  }
  for (const t of tokenize(query)) q.set(t, (q.get(t) || 0) + 2);
  return q;
}
