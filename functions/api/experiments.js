/**
 * /api/experiments — arm assignments and their outcomes.
 *
 * An experiment here is a named split over applications. Each application is
 * assigned to exactly one arm BEFORE it is sent, and that assignment is never
 * edited afterwards, which is the only thing that makes the comparison mean
 * anything: an arm decided or changed after the result is known measures
 * nothing but the decision.
 *
 * This route stores the assignment and the outcome. It does not store, know or
 * care what an arm CONTAINS. The content of a variant lives in Brian's local
 * profile and answer bank, which never leave his machine and are not in this
 * public repository.
 *
 * GET  /api/experiments                 every experiment with per-arm counts
 * GET  /api/experiments?name=<slug>     one experiment, with its assignments
 * POST /api/experiments                 assign an application to an arm
 *
 * Binding: DB -> D1 database 10e8a6c0-1fa7-4c33-a007-2044876ce6a7
 */

import { HEADERS, refuseWrite, preflight } from "./_auth.js";

/** An experiment or arm name: a short slug, so it can never reach SQL as anything else. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
  const name = new URL(request.url).searchParams.get("name");
  try {
    if (name) {
      if (!NAME.test(name)) {
        return new Response(JSON.stringify({ error: "name must be a slug" }),
          { status: 400, headers: HEADERS });
      }
      /* One row per assigned application, with the job it belongs to and the
         furthest stage it reached. LEFT JOIN, because an application with no
         outcome recorded yet is data -- it is the denominator. */
      const rows = await env.DB.prepare(
        `SELECT a.dedupe_key, a.arm, a.assigned_at,
                j.company, j.title, j.status, j.submitted_at, j.rank_pct,
                (SELECT o.stage FROM outcomes o
                  WHERE o.dedupe_key = a.dedupe_key
                  ORDER BY o.occurred_on DESC, o.id DESC LIMIT 1) AS latest_stage,
                (SELECT o.occurred_on FROM outcomes o
                  WHERE o.dedupe_key = a.dedupe_key
                  ORDER BY o.occurred_on DESC, o.id DESC LIMIT 1) AS latest_on
           FROM experiment_arms a
           LEFT JOIN jobs j ON j.dedupe_key = a.dedupe_key
          WHERE a.experiment = ?1
          ORDER BY a.assigned_at DESC`
      ).bind(name).all();
      return new Response(JSON.stringify({ experiment: name, assignments: rows.results || [] }),
        { headers: HEADERS });
    }

    const summary = await env.DB.prepare(
      `SELECT experiment, arm, COUNT(*) AS assigned,
              MIN(assigned_at) AS first_assigned,
              MAX(assigned_at) AS last_assigned
         FROM experiment_arms
        GROUP BY experiment, arm
        ORDER BY experiment, arm`
    ).all();
    return new Response(JSON.stringify({ experiments: summary.results || [] }), { headers: HEADERS });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "read failed", detail: String((error && error.message) || error) }),
      { status: 500, headers: HEADERS });
  }
}

/**
 * Assign one application to one arm. Refuses to move an application that is
 * already assigned, and refuses to assign one that has already been sent.
 *
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
  const experiment = typeof body.experiment === "string" ? body.experiment.trim() : "";
  const arm = typeof body.arm === "string" ? body.arm.trim() : "";
  if (!dedupeKey || dedupeKey.length > 512) {
    return new Response(JSON.stringify({ error: "dedupe_key is required (1-512 chars)" }),
      { status: 400, headers: HEADERS });
  }
  if (!NAME.test(experiment) || !NAME.test(arm)) {
    return new Response(JSON.stringify({ error: "experiment and arm must be slugs" }),
      { status: 400, headers: HEADERS });
  }

  try {
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE dedupe_key = ?1").bind(dedupeKey).first();
    if (!job) {
      return new Response(JSON.stringify({ error: "no job with that dedupe_key" }),
        { status: 404, headers: HEADERS });
    }
    /* Assigning after the application is out is assigning with the answer in
       hand. Refuse it rather than record a number that looks like evidence. */
    if (job.status === "submitted") {
      return new Response(
        JSON.stringify({ error: "already submitted: an arm chosen after the fact measures the choice, not the arm" }),
        { status: 409, headers: HEADERS });
    }
    const existing = await env.DB.prepare(
      "SELECT arm FROM experiment_arms WHERE dedupe_key = ?1 AND experiment = ?2"
    ).bind(dedupeKey, experiment).first();
    if (existing) {
      if (existing.arm === arm) {
        return new Response(JSON.stringify({ ok: true, dedupe_key: dedupeKey, experiment, arm, unchanged: true }),
          { headers: HEADERS });
      }
      return new Response(
        JSON.stringify({ error: "already assigned to a different arm", arm: existing.arm }),
        { status: 409, headers: HEADERS });
    }
    await env.DB.prepare(
      "INSERT INTO experiment_arms (dedupe_key, experiment, arm) VALUES (?1, ?2, ?3)"
    ).bind(dedupeKey, experiment, arm).run();
    return new Response(JSON.stringify({ ok: true, dedupe_key: dedupeKey, experiment, arm }), { headers: HEADERS });
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
