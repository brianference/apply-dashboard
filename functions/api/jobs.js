/**
 * GET /api/jobs — the read path for the dashboard.
 *
 * Reconstructed from the live production response and the real D1 schema on
 * 2026-08-22, because the original sandbox source was never checked in. The
 * response shape and row ordering match what production was already serving:
 * submitted lane first, then full-time, then PT/C2C, each by match_pct desc.
 *
 * Binding: DB -> D1 database 10e8a6c0-1fa7-4c33-a007-2044876ce6a7
 */

const COLUMNS = [
  "dedupe_key", "company", "title", "url", "match_pct", "source",
  "status", "lane", "submitted_at", "posted", "work_type", "updated_at"
];

/* salary_* was added on 2026-08-24 so the $180k floor in CRITERIA.md can be
   enforced instead of merely stated. Without these in the SELECT the backfill
   lands in D1 but nothing downstream can read it. */
const SELECT = `
  SELECT ${COLUMNS.join(", ")}, link_status, link_checked_at, blocked_reason, blocked_detail,
         salary_min, salary_max, salary_source,
         rank_pct, fit_pct, resume_pct, success_pct, rank_why, jd_read
  FROM jobs
  ORDER BY
    CASE lane WHEN 'submitted' THEN 0 WHEN 'ft' THEN 1 ELSE 2 END,
    match_pct DESC,
    company COLLATE NOCASE
`;

/** Same query without the later column groups, for a database not yet migrated.
    Built by stripping from the first added group onward, so a newly added group
    cannot be forgotten here and turn a fresh deploy against an old database
    into a 500. */
const SELECT_LEGACY = SELECT.replace(/,\s*link_status[\s\S]*?FROM jobs/, "\n  FROM jobs");

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

/**
 * Handle a preflight or a HEAD probe without falling through to the SPA asset.
 * @returns {Response}
 */
export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type"
    }
  });
}

/**
 * Read every job row.
 * @param {{ env: { DB: D1Database } }} context
 * @returns {Promise<Response>}
 */
export async function onRequestGet(context) {
  const { env } = context;
  if (!env || !env.DB) {
    return new Response(
      JSON.stringify({ error: "D1 binding DB is not bound to this deployment" }),
      { status: 500, headers: HEADERS }
    );
  }
  try {
    let rows;
    try {
      rows = (await env.DB.prepare(SELECT).all()).results;
    } catch (migrationError) {
      // link_status has not been added yet — serve the original columns.
      rows = (await env.DB.prepare(SELECT_LEGACY).all()).results;
    }
    return new Response(JSON.stringify({ jobs: rows || [] }), { headers: HEADERS });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "query failed", detail: String(error && error.message || error) }),
      { status: 500, headers: HEADERS }
    );
  }
}

/**
 * Anything that is not GET/OPTIONS is a real 405, not the SPA fallback.
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { ...HEADERS, allow: "GET, OPTIONS" }
  });
}
