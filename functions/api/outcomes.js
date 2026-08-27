/**
 * /api/outcomes — what actually happened after an application.
 *
 * Nothing in this system recorded whether an application led to anything, so
 * no experiment of any kind could be measured and neither could the pipeline
 * itself. This is the missing half.
 *
 * One row per state change rather than one row per application. A rejection
 * after a screen is a different result from a rejection with no reply, and
 * overwriting a single status column would lose that difference forever.
 *
 * GET  /api/outcomes                      every recorded outcome
 * GET  /api/outcomes?key=<dedupe_key>     the history for one application
 * POST /api/outcomes                      record one
 *
 * Binding: DB -> D1 database 10e8a6c0-1fa7-4c33-a007-2044876ce6a7
 */

import { HEADERS, refuseWrite, preflight } from "./_auth.js";

/**
 * The ladder, in order. Position matters: "furthest stage reached" is what a
 * callback rate counts, and it can only be computed from an ordered set.
 */
export const STAGES = [
  "no-response",
  "rejected",
  "recruiter-screen",
  "hiring-manager",
  "interview",
  "onsite",
  "offer",
  "withdrawn"
];

/** ISO calendar date, so outcomes from different sources sort against each other. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @returns {Response}
 */
export function onRequestOptions() {
  return preflight("GET, POST, OPTIONS");
}

/**
 * @param {{ request: Request, env: { DB: D1Database } }} context
 * @returns {Promise<Response>}
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }),
      { status: 500, headers: HEADERS });
  }
  const key = new URL(request.url).searchParams.get("key");
  try {
    const stmt = key
      ? env.DB.prepare(
          `SELECT o.*, j.company, j.title FROM outcomes o
             LEFT JOIN jobs j ON j.dedupe_key = o.dedupe_key
            WHERE o.dedupe_key = ?1 ORDER BY o.occurred_on DESC, o.id DESC`
        ).bind(key)
      : env.DB.prepare(
          `SELECT o.*, j.company, j.title FROM outcomes o
             LEFT JOIN jobs j ON j.dedupe_key = o.dedupe_key
            ORDER BY o.occurred_on DESC, o.id DESC LIMIT 1000`
        );
    const rows = await stmt.all();
    return new Response(JSON.stringify({ stages: STAGES, outcomes: rows.results || [] }), { headers: HEADERS });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "read failed", detail: String((error && error.message) || error) }),
      { status: 500, headers: HEADERS });
  }
}

/**
 * @param {{ request: Request, env: { DB: D1Database, APPLY_TOKEN?: string } }} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  const refused = refuseWrite(request, env);
  if (refused) return refused;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "body must be JSON" }), { status: 400, headers: HEADERS });
  }

  const dedupeKey = typeof body.dedupe_key === "string" ? body.dedupe_key.trim() : "";
  const stage = typeof body.stage === "string" ? body.stage.trim() : "";
  const occurredOn = typeof body.occurred_on === "string" ? body.occurred_on.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

  if (!dedupeKey || dedupeKey.length > 512) {
    return new Response(JSON.stringify({ error: "dedupe_key is required (1-512 chars)" }),
      { status: 400, headers: HEADERS });
  }
  if (!STAGES.includes(stage)) {
    return new Response(JSON.stringify({ error: "stage must be one of " + STAGES.join(", ") }),
      { status: 400, headers: HEADERS });
  }
  if (!DATE.test(occurredOn)) {
    return new Response(JSON.stringify({ error: "occurred_on must be YYYY-MM-DD" }),
      { status: 400, headers: HEADERS });
  }

  try {
    const job = await env.DB.prepare("SELECT dedupe_key FROM jobs WHERE dedupe_key = ?1").bind(dedupeKey).first();
    if (!job) {
      return new Response(JSON.stringify({ error: "no job with that dedupe_key" }), { status: 404, headers: HEADERS });
    }
    await env.DB.prepare(
      "INSERT INTO outcomes (dedupe_key, stage, occurred_on, note) VALUES (?1, ?2, ?3, ?4)"
    ).bind(dedupeKey, stage, occurredOn, note).run();
    return new Response(JSON.stringify({ ok: true, dedupe_key: dedupeKey, stage, occurred_on: occurredOn }),
      { headers: HEADERS });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "write failed", detail: String((error && error.message) || error) }),
      { status: 500, headers: HEADERS });
  }
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { ...HEADERS, allow: "GET, POST, OPTIONS" }
  });
}
