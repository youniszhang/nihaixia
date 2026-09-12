import crypto from 'node:crypto';

const SCRYPT_PREFIX = '$scrypt$';

// New hashes: pure-node scrypt (no native addon) so the server can be bundled
// into a single-file SEA binary for the desktop app.
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1, keylen = 64;
  const key = crypto.scryptSync(password, salt, keylen, { N, r, p });
  return `${SCRYPT_PREFIX}N=${N},r=${r},p=${p}$${salt.toString('base64')}$${key.toString('base64')}`;
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
      const actual = crypto.scryptSync(password, salt, expected.length, {
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
