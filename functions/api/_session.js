/**
 * Password hashing, sessions, CSRF and rate limiting.
 *
 * Every parameter here was measured or read from a primary source on
 * 2026-08-27, not remembered. The two that matter:
 *
 * OWASP's Password Storage Cheat Sheet recommends 600,000 iterations of
 * PBKDF2-HMAC-SHA256 and ranks Argon2id above PBKDF2 entirely.
 *
 * The Cloudflare Workers runtime REFUSES more than 100,000 PBKDF2 iterations.
 * A probe deployed to this project measured 10,000 / 50,000 / 100,000
 * succeeding and 210,000 failing with the exact error:
 *   "Pbkdf2 failed: iteration counts above 100000 are not supported
 *    (requested 210000)."
 * Argon2id is not available in this runtime either.
 *
 * So DO NOT "fix" ITERATIONS up to 600,000. It will not run, and if it somehow
 * did it would invalidate every stored hash. The gap is covered a different
 * way: the password is first HMAC'd with a server-side pepper that lives in the
 * Pages secret store and never in D1. OWASP endorses exactly this - peppering
 * "prevents an attacker from being able to crack any of the hashes if they only
 * have access to the database", provided the pepper is "stored separately from
 * the password database". A dump of `users` on its own is not crackable.
 */

/** Runtime maximum, not a choice. See the comment above before changing it. */
const ITERATIONS = 100000;
/** Recorded per user so the scheme can be upgraded without guessing later. */
export const KDF_ID = "hmac-pepper+pbkdf2-sha256-100000-v1";
/** 14 days. */
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

/**
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {string} standard base64
 */
export function toBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {string} base64url, no padding, safe in a cookie or a URL
 */
export function toBase64Url(buf) {
  return toBase64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * @param {number} bytes
 * @returns {string} base64url of that many cryptographically random bytes
 */
export function randomToken(bytes = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * SHA-256, hex encoded.
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Comparison whose duration does not depend on WHERE two strings differ.
 * A `===` on a secret leaks its prefix to anyone who can time the response.
 *
 * Different lengths return false immediately, which is safe: the length of a
 * base64 hash of fixed size is not itself a secret.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * HMAC-SHA256 the password with the deployment pepper, then stretch with
 * PBKDF2. See the file header for why it is built this way.
 *
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {string} pepper
 * @returns {Promise<string>} base64 of 32 derived bytes
 */
export async function hashPassword(password, salt, pepper) {
  if (!pepper) throw new Error("AUTH_PEPPER is not bound");
  const pepperKey = await crypto.subtle.importKey(
    "raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const pre = await crypto.subtle.sign("HMAC", pepperKey, encoder.encode(password));
  const kdfKey = await crypto.subtle.importKey("raw", pre, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, kdfKey, 256
  );
  return toBase64(bits);
}

/**
 * @param {string} password
 * @param {string} pepper
 * @returns {Promise<{hash: string, salt: string, kdf: string}>}
 */
export async function newPasswordRecord(password, pepper) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await hashPassword(password, salt, pepper), salt: toBase64(salt), kdf: KDF_ID };
}

/**
 * @param {string} password
 * @param {{password_hash: string, password_salt: string}} record
 * @param {string} pepper
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, record, pepper) {
  const computed = await hashPassword(password, fromBase64(record.password_salt), pepper);
  return constantTimeEqual(computed, record.password_hash);
}

/**
 * A salt and hash that belong to nobody, used so that a login attempt against
 * an address with no account still pays the full PBKDF2 cost. Without this the
 * endpoint answers "no such user" faster than "wrong password" and the timing
 * difference alone enumerates accounts.
 *
 * @param {string} pepper
 * @returns {Promise<void>}
 */
export async function burnEqualTime(pepper) {
  const salt = new Uint8Array(16);
  await hashPassword("this password belongs to no account", salt, pepper);
}

/* ---------------------------------------------------------------- sessions */

/** The cookie name carries the __Host- prefix; see setSessionCookie. */
export const COOKIE = "__Host-session";

/**
 * @param {Request} request
 * @returns {string|null} the raw cookie value, if present
 */
export function readCookie(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}

/**
 * Browsers only honour the __Host- prefix when the cookie is Secure, has
 * Path=/, and carries NO Domain attribute. Get one of those wrong and the
 * browser silently treats it as an ordinary cookie rather than rejecting it,
 * so the protection disappears without anything failing.
 *
 * @param {string} value
 * @param {number} [maxAgeSeconds]
 * @returns {string}
 */
export function sessionCookie(value, maxAgeSeconds = SESSION_MS / 1000) {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/**
 * @returns {string} a Set-Cookie that removes the session cookie
 */
export function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Create a session and return the value to put in the cookie.
 *
 * The database stores the SHA-256 of that value, never the value itself, so a
 * dump of `sessions` cannot be replayed as a login.
 *
 * @param {D1Database} db
 * @param {string} userId
 * @returns {Promise<string>} the cookie value
 */
export async function createSession(db, userId) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_MS);
  await db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)"
  ).bind(await sha256Hex(token), userId, now.toISOString(), expires.toISOString()).run();
  return token;
}

/**
 * The signed-in user, or null. Also refreshes last_seen_at.
 *
 * @param {Request} request
 * @param {{DB: D1Database}} env
 * @returns {Promise<{id: string, email: string, since: string}|null>}
 */
export async function currentUser(request, env) {
  const token = readCookie(request);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.created_at, s.expires_at, s.revoked_at, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?1`
  ).bind(id).first();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2")
    .bind(new Date().toISOString(), id).run();
  return { id: row.user_id, email: row.email, since: row.created_at };
}

/**
 * @param {D1Database} db
 * @param {string} token the cookie value
 * @returns {Promise<void>}
 */
export async function revokeSession(db, token) {
  if (!token) return;
  await db.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2")
    .bind(new Date().toISOString(), await sha256Hex(token)).run();
}

/**
 * @param {D1Database} db
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function revokeAllSessions(db, userId) {
  await db.prepare("UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL")
    .bind(new Date().toISOString(), userId).run();
}

/* -------------------------------------------------------------------- CSRF */

/**
 * With cookie authentication, a form on another origin would otherwise post
 * here carrying the cookie. SameSite=Lax is a second layer; this is the first.
 *
 * A POST with NO Origin header is refused rather than allowed. Browsers send
 * Origin on cross-site POSTs, so a missing one is either a non-browser caller
 * or something stripping it, and neither should be trusted with a write.
 *
 * @param {Request} request
 * @param {{SITE_ORIGIN?: string}} env
 * @returns {boolean} true when the request may proceed
 */
export function originAllowed(request, env) {
  const expected = env && env.SITE_ORIGIN;
  if (!expected) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return constantTimeEqual(origin, expected);
}

/* ----------------------------------------------------------- rate limiting */

/**
 * Windows in minutes and the number of attempts allowed inside them.
 * Login is the loosest because a real person mistypes a password.
 */
const LIMITS = {
  login: { windowMinutes: 15, max: 10 },
  register: { windowMinutes: 60, max: 5 },
  reset: { windowMinutes: 60, max: 5 }
};

/**
 * Record an attempt and say whether this bucket has now had too many.
 *
 * Called once per bucket - the email and the caller's IP are separate buckets,
 * because limiting only by email lets one attacker spray many addresses, and
 * limiting only by IP lets a botnet through.
 *
 * @param {D1Database} db
 * @param {string} bucket
 * @param {keyof LIMITS} kind
 * @returns {Promise<boolean>} true when the caller is over the limit
 */
export async function overLimit(db, bucket, kind) {
  const limit = LIMITS[kind];
  if (!limit) return false;
  const now = Date.now();
  const since = new Date(now - limit.windowMinutes * 60 * 1000).toISOString();
  await db.prepare("INSERT INTO auth_attempts (bucket, kind, at) VALUES (?1, ?2, ?3)")
    .bind(bucket, kind, new Date(now).toISOString()).run();
  /* Opportunistic cleanup, so the table cannot grow without bound and nothing
     has to remember to schedule a sweep. */
  await db.prepare("DELETE FROM auth_attempts WHERE at < ?1")
    .bind(new Date(now - 24 * 60 * 60 * 1000).toISOString()).run();
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM auth_attempts WHERE bucket = ?1 AND kind = ?2 AND at >= ?3"
  ).bind(bucket, kind, since).first();
  return ((row && row.n) || 0) > limit.max;
}

/**
 * @param {Request} request
 * @returns {Promise<string>} a bucket key for the caller's address
 */
export async function ipBucket(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return "ip:" + (await sha256Hex(ip)).slice(0, 32);
}
