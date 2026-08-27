/**
 * Shared write auth for the API.
 *
 * apply.js and blocked.js each carry their own copy of this. A third copy in
 * the experiments routes would be a fourth place for the rule to drift, and a
 * write endpoint whose auth quietly differs from its neighbours is the shape
 * that turns into an open endpoint.
 */

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
 * Refuse the request unless D1 is bound and the caller's token matches.
 * Fails CLOSED: with no APPLY_TOKEN bound every write is refused, so a
 * misconfigured deploy cannot become an open write endpoint.
 *
 * @param {Request} request
 * @param {{ DB?: unknown, APPLY_TOKEN?: string }} env
 * @returns {Response|null} a refusal, or null when the caller may write
 */
export function refuseWrite(request, env) {
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }),
      { status: 500, headers: HEADERS });
  }
  if (!env.APPLY_TOKEN) {
    return new Response(
      JSON.stringify({ error: "writes are disabled: APPLY_TOKEN is not bound to this deployment" }),
      { status: 503, headers: HEADERS });
  }
  if (!safeEqual(request.headers.get("x-apply-token") || "", env.APPLY_TOKEN)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: HEADERS });
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
