import crypto from 'node:crypto';

const SCRYPT_PREFIX = '$scrypt$';

// scrypt 参数：N=16384 单次约 20ms，同步版会阻塞事件循环（并发登录时整个进程卡住）。
// 统一用 promisify 的异步版本，把 CPU 计算放到 libuv 线程池。
const N = 16384, R = 8, P = 1, KEYLEN = 64;

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// New hashes: pure-node scrypt (no native addon) so the server can be bundled
// into a single-file SEA binary for the desktop app.
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `${SCRYPT_PREFIX}N=${N},r=${R},p=${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith(SCRYPT_PREFIX)) {
    try {
      // format: $scrypt$N=...,r=...,p=...$<saltB64>$<keyB64>
      const [, , params, saltB64, keyB64] = stored.split('$');
      const opts = Object.fromEntries(params.split(',').map((kv) => kv.split('=')));
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(keyB64, 'base64');
      const actual = await scryptAsync(password, salt, expected.length, {
        N: Number(opts.N), r: Number(opts.r), p: Number(opts.p),
      });
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  // Legacy argon2 hashes (server deployments created before the scrypt switch).
  // Optional dependency — unavailable inside the desktop SEA build.
  if (stored.startsWith('$argon2')) {
    try {
      const { default: argon2 } = await import('argon2');
      return await argon2.verify(stored, password);
    } catch {
      return false;
    }
  }
  return false;
}
