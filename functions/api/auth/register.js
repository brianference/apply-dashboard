/**
 * POST /api/auth/register — make an account.
 *
 * This route did not exist. It was specified, the rest of the auth system was
 * built around it, and it was never written, so /api/auth/register answered 405
 * and nobody but the owner could ever have an account. A walk-through as a
 * stranger is what found it.
 *
 * Registration is OPEN: the product invites other product managers to keep
 * their own job list and host their own portfolio, and an invitation that
 * returns 405 is not one.
 *
 * The response is the same whether or not the address is already registered.
 * OWASP's Authentication Cheat Sheet gives the correct wording as "A link to
 * activate your account has been emailed to the address provided" - saying
 * "that email is taken" would tell a stranger who has an account here.
 */

import { HEADERS, preflight } from "../_auth.js";
import { newPasswordRecord, randomToken, sha256Hex, originAllowed, overLimit, ipBucket } from "../_session.js";
import { sendMail, linkEmail } from "../_mail.js";

/**
 * OWASP sets a 15 character minimum where there is no MFA, and asks that the
 * maximum be at least 64 so passphrases work.
 */
const MIN_LENGTH = 15;
const MAX_BYTES = 200;
/** 24 hours to click the link. */
const TTL_MS = 24 * 60 * 60 * 1000;

const GENERIC = {
  ok: true,
  message: "A link to activate your account has been emailed to the address provided. "
    + "Make sure to check your spam folder."
};

/** A handle is a URL path segment, so it is constrained to what belongs in one. */
const HANDLE_OK = /^[a-z0-9][a-z0-9-]{1,38}$/;

/**
 * A handle from an email local part, made unique against what already exists.
 *
 * @param {D1Database} db
 * @param {string} email
 * @returns {Promise<string>}
 */
export async function freeHandle(db, email) {
  const base = String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "member";
  let candidate = HANDLE_OK.test(base) ? base : "member";
  for (let n = 0; n < 50; n++) {
    const taken = await db.prepare("SELECT 1 AS x FROM profile WHERE handle = ?1").bind(candidate).first();
    if (!taken) return candidate;
    candidate = `${base.slice(0, 30)}-${n + 2}`;
  }
  return `${base.slice(0, 24)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @returns {Response}
 */
export function onRequestOptions() {
  return preflight("POST, OPTIONS");
}

/**
 * @param {{request: Request, env: {DB: D1Database, AUTH_PEPPER?: string, SITE_ORIGIN?: string}}} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }), { status: 500, headers: HEADERS });
  }
  if (!env.AUTH_PEPPER) {
    return new Response(JSON.stringify({ error: "registration is disabled: AUTH_PEPPER is not bound" }), { status: 503, headers: HEADERS });
  }
  if (!originAllowed(request, env)) {
    return new Response(JSON.stringify({ error: "bad origin" }), { status: 403, headers: HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "body must be JSON" }), { status: 400, headers: HEADERS });
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  /* Shape errors are told plainly: they are about what the caller just typed,
     not about who else exists. */
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return new Response(JSON.stringify({ error: "Enter a valid email address." }), { status: 400, headers: HEADERS });
  }
  if (password.length < MIN_LENGTH) {
    return new Response(JSON.stringify({ error: `Password must be at least ${MIN_LENGTH} characters.` }), { status: 400, headers: HEADERS });
  }
  if (new TextEncoder().encode(password).length > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "Password is too long." }), { status: 400, headers: HEADERS });
  }

  const tooMany = (await overLimit(env.DB, "email:" + email, "register"))
    || (await overLimit(env.DB, await ipBucket(request), "register"));
  if (tooMany) {
    return new Response(JSON.stringify(GENERIC), { headers: HEADERS });
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
  if (existing) {
    /* Identical response, no new row, nothing emailed. The address is already
       registered and saying so would answer a question a stranger should not
       be able to ask. */
    return new Response(JSON.stringify(GENERIC), { headers: HEADERS });
  }

  const record = await newPasswordRecord(password, env.AUTH_PEPPER);
  const userId = crypto.randomUUID();
  const now = new Date();

  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, kdf, email_verified, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)`
  ).bind(userId, email, record.hash, record.salt, record.kdf, now.toISOString()).run();

  /* Their own profile row, so the portfolio they land on is theirs and not
     somebody else's. */
  const handle = await freeHandle(env.DB, email);
  await env.DB.prepare(
    "INSERT INTO profile (user_id, handle, display_name, updated_at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(userId, handle, email.split("@")[0], now.toISOString()).run();

  const token = randomToken(32);
  await env.DB.prepare(
    "INSERT INTO email_tokens (id, user_id, purpose, created_at, expires_at) VALUES (?1, ?2, 'verify', ?3, ?4)"
  ).bind(await sha256Hex(token), userId, now.toISOString(), new Date(now.getTime() + TTL_MS).toISOString()).run();

  const url = `${env.SITE_ORIGIN}/login/?verify=${encodeURIComponent(token)}`;
  const mail = linkEmail(
    "Confirm your email",
    "Use the link below to activate your AI PM Jobs account. It works once and expires in 24 hours.",
    url,
    "Activate account"
  );
  const sent = await sendMail(env, { to: email, subject: "Activate your AI PM Jobs account", html: mail.html, text: mail.text });
  if (!sent.sent) console.warn("registration mail failed", sent.detail);

  return new Response(JSON.stringify(GENERIC), { headers: HEADERS });
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "POST, OPTIONS" }
  });
}
