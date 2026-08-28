/**
 * POST /api/apply — mark one queued posting as submitted.
 *
 * The dashboard calls this after it has opened the real application form, so
 * the queue stops re-offering a job that has already been sent.
 *
 * Auth: see refuseWrite in ./_auth.js. A person in a browser proves it with a
 * session cookie from signing in; apply/batch.mjs and apply/runner.mjs, which
 * run on Brian's machine and cannot hold a cookie, prove it with the shared
 * APPLY_TOKEN header. Either is enough, neither is a refusal, and the whole
 * thing fails closed.
 *
 * Binding: DB -> D1 database 10e8a6c0-1fa7-4c33-a007-2044876ce6a7
 */

import { HEADERS, refuseWrite, preflight } from "./_auth.js";
import { currentUser } from "./_session.js";

/** Statuses a caller is allowed to set. */
const ALLOWED_STATUS = new Set(["submitted", "queued", "skipped"]);

/**
 * @returns {Response}
 */
export function onRequestOptions() {
  return preflight("POST, OPTIONS");
}

/**
 * @param {{ request: Request, env: { DB: D1Database, APPLY_TOKEN?: string } }} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const refused = await refuseWrite(request, env);
  if (refused) return refused;

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

  /* A PERSON's mark goes on their own overlay, never on the shared row.
     jobs.status belongs to the pipeline: the runner writes it and the ingest
     reads it. If a signed-in visitor wrote there, marking a job applied would
     delete it from everybody else's list, which is exactly the thing this
     product must not do. The machine token still writes the shared column,
     because that caller IS the pipeline. */
  const user = await currentUser(request, env);
  if (user) {
    const job = await env.DB.prepare("SELECT dedupe_key FROM jobs WHERE dedupe_key = ?1").bind(dedupeKey).first();
    if (!job) {
      return new Response(JSON.stringify({ error: "no job with that dedupe_key", dedupe_key: dedupeKey }),
        { status: 404, headers: HEADERS });
    }
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, dedupe_key, status, submitted_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
         status = excluded.status,
         submitted_at = COALESCE(user_jobs.submitted_at, excluded.submitted_at),
         updated_at = excluded.updated_at`
    ).bind(user.id, dedupeKey, status, isSubmit ? now : null, now).run();
    return new Response(
      JSON.stringify({ ok: true, dedupe_key: dedupeKey, status, submitted_at: isSubmit ? now : null, scope: "account" }),
      { headers: HEADERS });
  }

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
