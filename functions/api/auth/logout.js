/**
 * POST /api/auth/logout — revoke this session and clear the cookie.
 *
 * Revoking in the database as well as clearing the cookie matters: a cookie
 * copied off the machine before logout would otherwise still work.
 */

import { HEADERS, preflight } from "../_auth.js";
import { readCookie, revokeSession, clearCookie, originAllowed } from "../_session.js";

/**
 * @returns {Response}
 */
export function onRequestOptions() {
  return preflight("POST, OPTIONS");
}

/**
 * @param {{request: Request, env: {DB: D1Database, SITE_ORIGIN?: string}}} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!originAllowed(request, env)) {
    return new Response(JSON.stringify({ error: "bad origin" }), { status: 403, headers: HEADERS });
  }
  if (env && env.DB) await revokeSession(env.DB, readCookie(request));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...HEADERS, "set-cookie": clearCookie() }
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
