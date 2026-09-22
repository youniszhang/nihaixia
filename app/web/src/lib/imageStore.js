// 图片本地存储（浏览器 IndexedDB）
//
// 为什么用 IndexedDB 而不是 localStorage：
//   · localStorage 只存字符串、容量约 5MB，一张手机照的 base64 就吃掉大半；
//   · IndexedDB 能存 Blob、容量按配额走（通常几百 MB），且读写不阻塞主线程。
//
// 关键约定（服务端不存图，这是唯一副本）：
//   服务器只保存「[图片:<id>]」这个文本标记，原图只在本机。所以：
//     · 换设备 / 换浏览器 / 清了站点数据 → 图片打不开，只剩标识；
//     · 无痕模式关掉窗口即失效。
//   这是设计取舍（用户明确要求服务端不留存），UI 必须把这点讲给用户听。

const DB_NAME = 'xuanshu_images';
const DB_VERSION = 1;
const STORE = 'images';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB 不可用')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('created_at', 'created_at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'));
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
  }));
}

// 生成一个安全的图片 id（服务端只允许 [A-Za-z0-9_-]，且会写进消息文本）
export function newImageId() {
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `img_${rand}`;
}

// 存一张图：blob 是压缩后的图片，uri 是给服务端的 data URI
export async function putImage({ id, blob, uri, mime, width, height }) {
  try {
    await tx('readwrite', (store) => store.put({
      id, blob, uri, mime, width, height, created_at: Date.now(),
    }));
    return true;
  } catch {
    // 存不下（配额满/无痕模式）不该让整个发送流程失败：图仍能本轮投喂，只是回看不到
    return false;
  }
}

export async function getImage(id) {
  try {
    const row = await tx('readonly', (store) => store.get(id));
    return row || null;
  } catch {
    return null;
  }
}

export async function deleteImage(id) {
  try { await tx('readwrite', (store) => store.delete(id)); } catch { /* ignore */ }
}

// 按 id 批量取（消息渲染时用），返回 { id: url } —— url 是 objectURL，调用方负责 revoke
export async function getImageMap(ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  await Promise.all(ids.map(async (id) => {
    const row = await getImage(id);
    if (row && row.blob) {
      try { out[id] = URL.createObjectURL(row.blob); } catch { /* ignore */ }
    }
  }));
  return out;
}

// 清理：删掉不再被任何消息引用的图片，避免长期使用后配额被历史图占满
export async function pruneImages(keepIds) {
  const keep = new Set(keepIds || []);
  try {
    const rows = await tx('readonly', (store) => store.getAll());
    for (const r of (rows || [])) {
      if (!keep.has(r.id)) await deleteImage(r.id);
    }
  } catch { /* ignore */ }
}

// 从消息文本里提取图片标记 id：形如 [图片:img_ab12cd]
const MARKER_RE = /\[图片:([A-Za-z0-9_-]{1,40})\]/g;

export function extractImageIds(text) {
  if (!text) return [];
  const ids = [];
  let m;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(text)) !== null) ids.push(m[1]);
  return ids;
}
