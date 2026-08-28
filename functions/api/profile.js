/**
 * /api/profile — the private view, and the only way to change it.
 *
 * PRIVATE, unlike /api/portfolio. This one returns the resume text and the raw
 * links, because it exists so Brian can see and edit exactly what the public
 * page is built from. A session is required for both reading and writing.
 *
 * GET  /api/profile   the whole row
 * PUT  /api/profile   update the fields a person edits
 *
 * Binding: DB -> D1 database 10e8a6c0-1fa7-4c33-a007-2044876ce6a7
 */

import { HEADERS, preflight } from "./_auth.js";
import { currentUser, originAllowed } from "./_session.js";

/** Only these are editable here. resume_text is replaced by the extractor. */
const EDITABLE = ["headline", "location", "resume_filename", "linkedin_url", "github_url"];

/**
 * @returns {Response}
 */
export function onRequestOptions() {
  return preflight("GET, PUT, OPTIONS");
}

/**
 * @param {{request: Request, env: {DB: D1Database}}} context
 * @returns {Promise<Response>}
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }), { status: 500, headers: HEADERS });
  }
  const user = await currentUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: "sign in to view your profile" }), { status: 401, headers: HEADERS });
  }
  const row = await env.DB.prepare(
    "SELECT headline, location, resume_filename, resume_text, linkedin_url, github_url, updated_at FROM profile WHERE id = 1"
  ).first();
  return new Response(JSON.stringify({
    profile: row || null,
    /* The length rather than nothing, so the page can say whether a resume is
       loaded without shipping ten thousand characters to render a status line. */
    resume_chars: row && row.resume_text ? row.resume_text.length : 0
  }), { headers: HEADERS });
}

/**
 * @param {{request: Request, env: {DB: D1Database, SITE_ORIGIN?: string}}} context
 * @returns {Promise<Response>}
 */
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }), { status: 500, headers: HEADERS });
  }
  if (!originAllowed(request, env)) {
    return new Response(JSON.stringify({ error: "bad origin" }), { status: 403, headers: HEADERS });
  }
  const user = await currentUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: "sign in to change your profile" }), { status: 401, headers: HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "body must be JSON" }), { status: 400, headers: HEADERS });
  }

  const sets = [];
  const values = [];
  for (const field of EDITABLE) {
    if (!(field in body)) continue;
    const value = body[field] === null || body[field] === "" ? null : String(body[field]).slice(0, 500);
    /* A link that is not http(s) is refused rather than stored. The portfolio
       renders these as anchors on a public page. */
    if (value && field.endsWith("_url") && !/^https?:\/\//i.test(value)) {
      return new Response(JSON.stringify({ error: `${field} must start with http:// or https://` }), { status: 400, headers: HEADERS });
    }
    sets.push(`${field} = ?`);
    values.push(value);
  }
  if (!sets.length) {
    return new Response(JSON.stringify({ error: "nothing to update" }), { status: 400, headers: HEADERS });
  }
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());

  /* The column names come from the EDITABLE allowlist above, never from the
     request; only the VALUES are bound. A field name arriving from the caller
     would be the injection this shape usually has. */
  await env.DB.prepare(`UPDATE profile SET ${sets.join(", ")} WHERE id = 1`).bind(...values).run();
  const row = await env.DB.prepare(
    "SELECT headline, location, resume_filename, linkedin_url, github_url, updated_at FROM profile WHERE id = 1"
  ).first();
  return new Response(JSON.stringify({ ok: true, profile: row }), { headers: HEADERS });
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "GET, PUT, OPTIONS" }
  });
}
