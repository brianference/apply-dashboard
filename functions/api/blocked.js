/**
 * POST /api/blocked — record why a posting could not be auto-applied.
 *
 * The dashboard uses this to show a "Manual" badge and an explanation, so a
 * posting the runner cannot finish becomes an actionable item rather than
 * disappearing silently.
 *
 * Auth: the same APPLY_TOKEN header as /api/apply. Fails closed.
 */

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

/** Reasons the runner is allowed to record. */
const ALLOWED = new Set([
  "needs-input", "no-submit-button", "needs-account-or-wizard",
  "captcha", "wall", "location-ineligible", "needs-consent-decision",
  "upload-failed", "submitted-unconfirmed", "crashed", "posting-closed",
  /* Added 2026-08-24. The runner learned to tell these apart and the allowlist
     fails closed, so without them the record was rejected and the posting
     looked untouched. */
  "captcha-blocked",     // form POST answered 403/429 by a bot wall
  "needs-email-code",    // board emailed a one-time code; a human must finish
  "code-unconfirmed",    // code entered, board still did not confirm
  "employer-rate-limit", // e.g. Kit: no more than 2 applications per 60 days
  "off-criteria",        // excluded by CRITERIA.md or a standing instruction
  /* Added 2026-08-25. The Workday driver reports its own states and NONE of
     them were listed, so every wd-* record was rejected by this fail-closed
     allowlist and all 31 Workday rows sat on the dashboard with a null
     blocked_reason, looking untouched. Six of them were waiting on nothing
     more than Brian clicking a verification link in his inbox, and there was
     no way for him to know. This is the second time this allowlist has
     silently swallowed a whole class of reason. */
  "wd-email-verification",   // account created, tenant emailed a verification link
  "wd-auth-blocked",         // could not sign in or create an account
  "wd-validation-blocked",   // a required field the driver could not satisfy
  "wd-unknown-question",     // a tenant question with no rule
  "wd-no-apply-path",        // no Apply control, or the posting is gone
  "wd-stuck",                // a valid page that would not advance
  "wd-review-reached-dry-run"
]);

/**
 * Constant-time compare so a wrong token cannot be recovered by timing.
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

/** @returns {Response} */
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
    return new Response(JSON.stringify({ error: "writes disabled: APPLY_TOKEN not bound" }),
      { status: 503, headers: HEADERS });
  }
  if (!safeEqual(request.headers.get("x-apply-token") || "", env.APPLY_TOKEN)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: HEADERS });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: "body must be JSON" }), { status: 400, headers: HEADERS }); }

  const key = typeof body.dedupe_key === "string" ? body.dedupe_key.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, 500) : "";
  if (!key || !reason) {
    return new Response(JSON.stringify({ error: "dedupe_key and reason are required" }),
      { status: 400, headers: HEADERS });
  }
  if (!ALLOWED.has(reason)) {
    return new Response(JSON.stringify({ error: "unknown reason", allowed: [...ALLOWED] }),
      { status: 400, headers: HEADERS });
  }

  try {
    const r = await env.DB.prepare(
      `UPDATE jobs SET blocked_reason = ?1, blocked_detail = ?2, blocked_at = ?3
        WHERE dedupe_key = ?4 AND status = 'queued'`
    ).bind(reason, detail || null, new Date().toISOString(), key).run();
    const changed = (r.meta && r.meta.changes) || 0;
    if (!changed) {
      return new Response(JSON.stringify({ error: "no queued job with that dedupe_key" }),
        { status: 404, headers: HEADERS });
    }
    return new Response(JSON.stringify({ ok: true, dedupe_key: key, reason }), { headers: HEADERS });
  } catch (error) {
    return new Response(JSON.stringify({ error: "write failed", detail: String(error && error.message || error) }),
      { status: 500, headers: HEADERS });
  }
}

/** @returns {Response} */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "POST, OPTIONS" }
  });
}
