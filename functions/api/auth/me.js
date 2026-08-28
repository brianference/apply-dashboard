/**
 * GET /api/auth/me — who, if anyone, is signed in.
 *
 * This is what the pages call on load to decide whether to show write controls.
 * It never returns a hash, a salt, a session id or a token.
 */

import { HEADERS } from "../_auth.js";
import { currentUser } from "../_session.js";

/**
 * @param {{request: Request, env: {DB: D1Database}}} context
 * @returns {Promise<Response>}
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ authenticated: false }), { headers: HEADERS });
  }
  const user = await currentUser(request, env);
  if (!user) return new Response(JSON.stringify({ authenticated: false }), { headers: HEADERS });
  /* The display name comes from the profile row rather than being guessed from
     the address. "brianference" is one run of letters, so deriving initials
     from the email gives BR; deriving them from "Brian Ference" gives BF, which
     is what a person expects to see in their own avatar. */
  let name = null;
  let avatar = null;
  try {
    const row = await env.DB.prepare("SELECT display_name, avatar_data_url FROM profile WHERE id = 1").first();
    name = (row && row.display_name) || null;
    avatar = (row && row.avatar_data_url) || null;
  } catch { name = null; avatar = null; }
  return new Response(JSON.stringify({ authenticated: true, email: user.email, name, avatar, since: user.since }), { headers: HEADERS });
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "GET" }
  });
}
