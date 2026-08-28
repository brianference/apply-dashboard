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
 * The largest avatar accepted, as a data URL.
 *
 * The page resizes to 256px before sending, which lands well under this; the
 * cap is here so a caller that skips the page cannot put a megabyte in a row
 * that /api/auth/me reads on every single page load.
 */
const MAX_AVATAR_CHARS = 200000;

/** Only real raster images. No SVG: it can carry script. */
const AVATAR_PREFIX = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

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
    "SELECT display_name, headline, location, resume_filename, resume_text, linkedin_url, github_url, avatar_data_url, updated_at FROM profile WHERE id = 1"
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

  /* The avatar is handled apart from the text fields: it is validated by shape
     and by size, and it is the one value here that a page load reads on every
     request, so an oversized one is refused rather than stored. */
  if ("avatar_data_url" in body) {
    const avatar = body.avatar_data_url;
    if (avatar === null || avatar === "") {
      sets.push("avatar_data_url = ?");
      values.push(null);
    } else {
      const value = String(avatar);
      if (!AVATAR_PREFIX.test(value)) {
        return new Response(JSON.stringify({ error: "avatar must be a base64 PNG, JPEG or WEBP data URL" }), { status: 400, headers: HEADERS });
      }
      if (value.length > MAX_AVATAR_CHARS) {
        return new Response(JSON.stringify({ error: `avatar is too large (${Math.round(value.length / 1024)}KB); keep it under ${Math.round(MAX_AVATAR_CHARS / 1024)}KB` }), { status: 400, headers: HEADERS });
      }
      sets.push("avatar_data_url = ?");
      values.push(value);
    }
  }
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
  const saved = await env.DB.prepare(
    "SELECT display_name, headline, location, resume_filename, linkedin_url, github_url, avatar_data_url, updated_at FROM profile WHERE id = 1"
  ).first();
  return new Response(JSON.stringify({ ok: true, profile: saved }), { headers: HEADERS });
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "GET, PUT, OPTIONS" }
  });
}
