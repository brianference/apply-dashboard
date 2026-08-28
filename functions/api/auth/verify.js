/**
 * GET or POST /api/auth/verify — activate an account from the emailed link.
 *
 * Registration creates the account unverified and login refuses an unverified
 * one, so without this route a new account could never be used. Clicking the
 * link proves control of the address, which is the whole point of sending it.
 *
 * Signs them in on success, because being told "verified, now go and log in"
 * is a step that exists for no reason.
 */

import { HEADERS, preflight } from "../_auth.js";
import { sha256Hex, createSession, sessionCookie } from "../_session.js";

/**
 * @returns {Response}
 */
export function onRequestOptions() {
  return preflight("GET, POST, OPTIONS");
}

/**
 * @param {D1Database} db
 * @param {string} token
 * @returns {Promise<{ok: boolean, error?: string, userId?: string}>}
 */
async function consume(db, token) {
  if (!token) return { ok: false, error: "That link is invalid or has expired." };
  const id = await sha256Hex(token);
  const row = await db.prepare(
    "SELECT user_id, purpose, expires_at, used_at FROM email_tokens WHERE id = ?1"
  ).bind(id).first();
  const dead = !row || row.used_at || row.purpose !== "verify"
    || new Date(row.expires_at).getTime() <= Date.now();
  if (dead) return { ok: false, error: "That link is invalid or has expired." };

  const now = new Date().toISOString();
  /* Spend the token FIRST, so a failure after this cannot leave it replayable. */
  await db.prepare("UPDATE email_tokens SET used_at = ?1 WHERE id = ?2").bind(now, id).run();
  await db.prepare(
    "UPDATE users SET email_verified = 1, verified_at = COALESCE(verified_at, ?1) WHERE id = ?2"
  ).bind(now, row.user_id).run();
  return { ok: true, userId: row.user_id };
}

/**
 * @param {{request: Request, env: {DB: D1Database}}} context
 * @returns {Promise<Response>}
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }), { status: 500, headers: HEADERS });
  }
  const token = new URL(request.url).searchParams.get("token") || "";
  const result = await consume(env.DB, token);
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), { status: 400, headers: HEADERS });
  }
  const session = await createSession(env.DB, result.userId);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...HEADERS, "set-cookie": sessionCookie(session) }
  });
}

/**
 * @param {{request: Request, env: {DB: D1Database}}} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }), { status: 500, headers: HEADERS });
  }
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const result = await consume(env.DB, String(body.token || ""));
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), { status: 400, headers: HEADERS });
  }
  const session = await createSession(env.DB, result.userId);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...HEADERS, "set-cookie": sessionCookie(session) }
  });
}
