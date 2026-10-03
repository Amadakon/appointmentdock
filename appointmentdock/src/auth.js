import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || typeof pw !== 'string') return false;
  const [kind, n, saltB64, keyB64] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), key.length, { N: +n, r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(key, test);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

export function createSession(db, userId, days) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha256(token), userId, Date.now() + days * 86400000);
  return token;
}

export function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.phone, u.role, u.business_id, u.staff_id, u.email_verified, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// One-time "set your password" links (invites, platform setup, resets).
export function createPasswordToken(db, userId, hours = 72) {
  const token = randomToken();
  db.prepare('DELETE FROM password_tokens WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO password_tokens (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha256(token), userId, Date.now() + hours * 3600000);
  return token;
}

export function consumePasswordToken(db, token) {
  const row = db.prepare('SELECT user_id, expires_at FROM password_tokens WHERE token_hash = ?').get(sha256(token || ''));
  if (!row || row.expires_at < Date.now()) return null;
  db.prepare('DELETE FROM password_tokens WHERE user_id = ?').run(row.user_id);
  return row.user_id;
}

export function peekPasswordToken(db, token) {
  const row = db.prepare(`SELECT u.email, u.name, t.expires_at FROM password_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?`).get(sha256(token || ''));
  if (!row || row.expires_at < Date.now()) return null;
  return { email: row.email, name: row.name };
}

// Very small fixed-window limiter for login and booking endpoints.
export function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}
