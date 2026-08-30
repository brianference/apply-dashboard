/**
 * POST /api/tour/seen — record that the signed-in account has seen the tour.
 *
 * The file lives here; the URL is /api/tour/seen (see ./tour/seen.js).
 * Nothing else is written. Calling it twice is not an error: COALESCE keeps
 * the first timestamp.
 */

import { HEADERS, preflight } from "./_auth.js";
import { currentUser, originAllowed } from "./_session.js";

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
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }),
      { status: 500, headers: HEADERS });
  }
  if (!originAllowed(request, env)) {
    return new Response(JSON.stringify({ error: "bad origin" }), { status: 403, headers: HEADERS });
  }
  const user = await currentUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: "sign in to continue" }),
      { status: 401, headers: HEADERS });
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE profile SET tour_seen_at = COALESCE(tour_seen_at, ?1) WHERE user_id = ?2"
  ).bind(now, user.id).run();
  return new Response(JSON.stringify({ ok: true }), { headers: HEADERS });
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "POST, OPTIONS" }
  });
}
