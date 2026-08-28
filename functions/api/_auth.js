/**
 * Shared write auth for the API.
 *
 * apply.js and blocked.js each carry their own copy of this. A third copy in
 * the experiments routes would be a fourth place for the rule to drift, and a
 * write endpoint whose auth quietly differs from its neighbours is the shape
 * that turns into an open endpoint.
 */

import { currentUser, originAllowed } from "./_session.js";

/** JSON response headers used by every route. */
export const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

/**
 * Constant-time string compare, so a wrong token cannot be recovered by timing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Refuse the request unless the caller may write.
 *
 * There are two kinds of caller and they authenticate differently:
 *
 *  - A PERSON in a browser, holding a session cookie. This is the path the
 *    login system created, and it is why the dashboard no longer asks anyone
 *    to paste a token into a box.
 *  - A MACHINE, specifically apply/batch.mjs and apply/runner.mjs running on
 *    Brian's own machine, holding the shared APPLY_TOKEN. Those scripts mark
 *    postings applied over that header and cannot hold a cookie. Removing the
 *    token path would stop the apply pipeline dead, so it stays.
 *
 * Either is sufficient. Neither present is a refusal. Fails CLOSED: with no
 * APPLY_TOKEN bound the token path is unavailable rather than open, so a
 * misconfigured deploy cannot become an open write endpoint.
 *
 * @param {Request} request
 * @param {{ DB?: unknown, APPLY_TOKEN?: string, SITE_ORIGIN?: string }} env
 * @returns {Promise<Response|null>} a refusal, or null when the caller may write
 */
export async function refuseWrite(request, env) {
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }),
      { status: 500, headers: HEADERS });
  }

  const presented = request.headers.get("x-apply-token") || "";
  if (presented) {
    if (!env.APPLY_TOKEN) {
      return new Response(
        JSON.stringify({ error: "writes are disabled: APPLY_TOKEN is not bound to this deployment" }),
        { status: 503, headers: HEADERS });
    }
    if (!safeEqual(presented, env.APPLY_TOKEN)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: HEADERS });
    }
    return null;
  }

  /* Cookie auth, so a cross-site form post would otherwise carry the cookie.
     The Origin check is the first layer and SameSite=Lax the second. A machine
     caller never reaches here, so this does not break the runner. */
  if (!originAllowed(request, env)) {
    return new Response(JSON.stringify({ error: "bad origin" }), { status: 403, headers: HEADERS });
  }
  const user = await currentUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: "sign in to make changes" }), { status: 401, headers: HEADERS });
  }
  return null;
}

/**
 * A CORS preflight response for one method.
 * @param {string} methods
 * @returns {Response}
 */
export function preflight(methods) {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": methods,
      "access-control-allow-headers": "content-type, x-apply-token"
    }
  });
}
