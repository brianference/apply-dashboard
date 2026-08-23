/**
 * POST /api/apply — mark one queued posting as submitted.
 *
 * The dashboard calls this after it has opened the real application form, so
 * the queue stops re-offering a job that has already been sent.
 *
 * Auth: a shared token in the `x-apply-token` header, compared against the
 * APPLY_TOKEN secret bound to this Pages project. The token is never shipped
 * in page source; the browser reads it from localStorage after the owner
 * pastes it in once. Without APPLY_TOKEN bound, every write is refused —
 * fail closed, so a misconfigured deploy cannot become an open write endpoint.
 *
 * Binding: DB -> D1 database 10e8a6c0-1fa7-4c33-a007-2044876ce6a7
 */

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

/** Statuses a caller is allowed to set. */
const ALLOWED_STATUS = new Set(["submitted", "queued", "skipped"]);

/**
 * Constant-time string compare, so a wrong token cannot be recovered by timing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @returns {Response}
 */
export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-apply-token"
    }
  });
}

/**
 * @param {{ request: Request, env: { DB: D1Database, APPLY_TOKEN?: string } }} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const { request, env } = context;

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
    return new Response(JSON.stringify({ error: "unauthorized" }),
      { status: 401, headers: HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return new Response(JSON.stringify({ error: "body must be JSON" }),
      { status: 400, headers: HEADERS });
  }

  const dedupeKey = typeof body.dedupe_key === "string" ? body.dedupe_key.trim() : "";
  if (!dedupeKey || dedupeKey.length > 512) {
    return new Response(JSON.stringify({ error: "dedupe_key is required (1-512 chars)" }),
      { status: 400, headers: HEADERS });
  }
  const status = typeof body.status === "string" ? body.status.trim() : "submitted";
  if (!ALLOWED_STATUS.has(status)) {
    return new Response(
      JSON.stringify({ error: "status must be one of " + [...ALLOWED_STATUS].join(", ") }),
      { status: 400, headers: HEADERS });
  }

  const now = new Date().toISOString();
  const isSubmit = status === "submitted";

  try {
    // Parameterised throughout — no string concatenation into SQL.
    const result = await env.DB.prepare(
      `UPDATE jobs
          SET status = ?1,
              lane = CASE WHEN ?1 = 'submitted' THEN 'submitted' ELSE lane END,
              submitted_at = CASE WHEN ?1 = 'submitted' THEN COALESCE(submitted_at, ?2) ELSE NULL END,
              updated_at = ?2
        WHERE dedupe_key = ?3`
    ).bind(status, now, dedupeKey).run();

    const changed = (result.meta && result.meta.changes) || 0;
    if (!changed) {
      return new Response(JSON.stringify({ error: "no job with that dedupe_key", dedupe_key: dedupeKey }),
        { status: 404, headers: HEADERS });
    }
    return new Response(
      JSON.stringify({ ok: true, dedupe_key: dedupeKey, status, submitted_at: isSubmit ? now : null }),
      { headers: HEADERS });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "write failed", detail: String(error && error.message || error) }),
      { status: 500, headers: HEADERS });
  }
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { ...HEADERS, allow: "POST, OPTIONS" }
  });
}
