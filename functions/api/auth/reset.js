/**
 * POST /api/auth/reset — consume a link token and set the password.
 *
 * Receiving the emailed token proves control of the address, so a successful
 * reset also marks the account verified. That is what makes this the setup path
 * for the very first password as well as the recovery path afterwards, and it
 * is why no password ever has to be typed into a chat, a log or the repo.
 *
 * On success every session belonging to the user is revoked. If the reset was
 * done because someone else had the password, leaving their session alive would
 * make the reset pointless.
 */

import { HEADERS, preflight } from "../_auth.js";
import { sha256Hex, newPasswordRecord, originAllowed, revokeAllSessions, createSession, sessionCookie } from "../_session.js";

/**
 * OWASP's Authentication Cheat Sheet sets a 15 character minimum when MFA is
 * not enabled, and asks that the maximum be at least 64 so passphrases work.
 * There is no MFA here, so 15 it is.
 */
const MIN_LENGTH = 15;
const MAX_BYTES = 200;

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
    return new Response(JSON.stringify({ error: "password changes are disabled: AUTH_PEPPER is not bound" }), { status: 503, headers: HEADERS });
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
  const token = String(body.token || "").trim();
  const password = String(body.password || "");

  if (password.length < MIN_LENGTH) {
    return new Response(JSON.stringify({ error: `Password must be at least ${MIN_LENGTH} characters.` }), { status: 400, headers: HEADERS });
  }
  if (new TextEncoder().encode(password).length > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "Password is too long." }), { status: 400, headers: HEADERS });
  }
  if (!token) {
    return new Response(JSON.stringify({ error: "That link is invalid or has expired." }), { status: 400, headers: HEADERS });
  }

  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT id, user_id, purpose, expires_at, used_at FROM email_tokens WHERE id = ?1"
  ).bind(id).first();

  const expired = !row || row.used_at || row.purpose !== "reset"
    || new Date(row.expires_at).getTime() <= Date.now();
  if (expired) {
    return new Response(JSON.stringify({ error: "That link is invalid or has expired." }), { status: 400, headers: HEADERS });
  }

  const record = await newPasswordRecord(password, env.AUTH_PEPPER);
  const now = new Date().toISOString();

  /* Mark the token used FIRST. If anything after this fails, the link is spent
     rather than replayable. */
  await env.DB.prepare("UPDATE email_tokens SET used_at = ?1 WHERE id = ?2").bind(now, id).run();
  await env.DB.prepare(
    `UPDATE users
        SET password_hash = ?1, password_salt = ?2, kdf = ?3,
            email_verified = 1, verified_at = COALESCE(verified_at, ?4),
            failed_count = 0, locked_until = NULL
      WHERE id = ?5`
  ).bind(record.hash, record.salt, record.kdf, now, row.user_id).run();

  await revokeAllSessions(env.DB, row.user_id);
  /* Then sign them in on this browser, so setting a password lands them in the
     product rather than back at a login form typing it again. */
  const session = await createSession(env.DB, row.user_id);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...HEADERS, "set-cookie": sessionCookie(session) }
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
