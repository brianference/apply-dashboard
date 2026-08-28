/**
 * POST /api/auth/login
 *
 * Every failure returns the SAME body and the SAME status, whether the address
 * has no account, the password is wrong, or the account is unverified. OWASP's
 * Authentication Cheat Sheet requires an application to "respond (both HTTP and
 * HTML) in a generic manner" across exactly those cases, and gives
 * "Login failed; Invalid user ID or password." as the correct wording. Anything
 * more helpful is an account enumeration oracle.
 *
 * The same page warns that differing processing paths leak account existence
 * through response time, so a login for an address with no account still pays
 * the full PBKDF2 cost via burnEqualTime.
 */

import { HEADERS, preflight } from "../_auth.js";
import {
  verifyPassword, burnEqualTime, createSession, sessionCookie,
  originAllowed, overLimit, ipBucket
} from "../_session.js";

/** The one message. Used for every failure mode on purpose. */
const GENERIC = { error: "Login failed; Invalid user ID or password." };
/** Consecutive failures before the account locks, and the backoff in minutes. */
const LOCK_AFTER = 5;
const BACKOFF_MINUTES = [5, 15, 60];

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
    return new Response(JSON.stringify({ error: "sign-in is disabled: AUTH_PEPPER is not bound" }), { status: 503, headers: HEADERS });
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
  if (!email || !password || password.length > 200) {
    return new Response(JSON.stringify(GENERIC), { status: 401, headers: HEADERS });
  }

  /* Two buckets. Limiting only by email lets one attacker spray many
     addresses; limiting only by address lets a botnet through. */
  const tooMany = (await overLimit(env.DB, "email:" + email, "login"))
    || (await overLimit(env.DB, await ipBucket(request), "login"));
  if (tooMany) {
    return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), { status: 429, headers: HEADERS });
  }

  const user = await env.DB.prepare(
    "SELECT id, email, password_hash, password_salt, email_verified, failed_count, locked_until FROM users WHERE email = ?1"
  ).bind(email).first();

  if (!user) {
    /* Pay the same cost as a real attempt so the timing does not answer. */
    await burnEqualTime(env.AUTH_PEPPER);
    return new Response(JSON.stringify(GENERIC), { status: 401, headers: HEADERS });
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    await burnEqualTime(env.AUTH_PEPPER);
    return new Response(JSON.stringify(GENERIC), { status: 401, headers: HEADERS });
  }

  const ok = await verifyPassword(password, user, env.AUTH_PEPPER);

  if (!ok) {
    const failed = (user.failed_count || 0) + 1;
    let lockedUntil = null;
    if (failed >= LOCK_AFTER) {
      const step = Math.min(failed - LOCK_AFTER, BACKOFF_MINUTES.length - 1);
      lockedUntil = new Date(Date.now() + BACKOFF_MINUTES[step] * 60 * 1000).toISOString();
    }
    await env.DB.prepare("UPDATE users SET failed_count = ?1, locked_until = ?2 WHERE id = ?3")
      .bind(failed, lockedUntil, user.id).run();
    return new Response(JSON.stringify(GENERIC), { status: 401, headers: HEADERS });
  }

  /* An unverified account is a failure with the SAME response as a wrong
     password. Saying "verify your email first" would confirm the address
     exists, which is the thing the generic message exists to prevent. */
  if (!user.email_verified) {
    return new Response(JSON.stringify(GENERIC), { status: 401, headers: HEADERS });
  }

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE users SET failed_count = 0, locked_until = NULL, last_login_at = ?1 WHERE id = ?2")
    .bind(now, user.id).run();
  const token = await createSession(env.DB, user.id);

  return new Response(JSON.stringify({ ok: true, email: user.email }), {
    headers: { ...HEADERS, "set-cookie": sessionCookie(token) }
  });
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "POST, OPTIONS" }
  });
}
