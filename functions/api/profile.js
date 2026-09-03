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
import {
  parseResume, normalizeSections, ensureProfileColumns
} from "./_profile-parse.js";

/** Stored JSON is what the person saved. Cap matches the avatar: a caller
    that skips the page cannot put a megabyte in a row the public page reads. */
const MAX_SECTIONS_CHARS = 200000;

const PROFILE_COLUMNS = "display_name, handle, headline, location, resume_filename, resume_text, linkedin_url, github_url, avatar_data_url, profile_sections, updated_at";

/**
 * D1 runner the column guard expects. PRAGMA/SELECT use `.all()` so the
 * Workers envelope `{ results }` is what pragmaColumns already knows;
 * ALTER uses `.run()`.
 *
 * @param {D1Database} db
 * @param {string} sql
 * @returns {Promise<any>}
 */
function d1Run(db, sql) {
  if (/^\s*PRAGMA/i.test(sql) || /^\s*SELECT/i.test(sql)) return db.prepare(sql).all();
  return db.prepare(sql).run();
}

/**
 * @param {unknown} raw
 * @returns {object|null}
 */
function readSections(raw) {
  if (raw == null || raw === "") return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizeSections(parsed);
  } catch {
    return null;
  }
}

let profileColumnsReady = false;
/**
 * @param {D1Database} db
 * @returns {Promise<void>}
 */
async function readyProfileColumns(db) {
  if (profileColumnsReady) return;
  await ensureProfileColumns((sql) => d1Run(db, sql));
  profileColumnsReady = true;
}

/** Only these are editable here. resume_text is replaced by the extractor. */
const EDITABLE = ["display_name", "headline", "location", "resume_filename", "linkedin_url", "github_url"];

/**
 * A handle is a path segment on a public URL, so it is constrained to what
 * belongs in one: lowercase letters, digits and single hyphens between them.
 * Deliberately NOT in EDITABLE - that loop only trims to 500 characters, and a
 * handle needs a shape check, a reserved-word check and a uniqueness check that
 * the loop cannot do.
 */
const HANDLE_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HANDLE_MIN = 3;
const HANDLE_MAX = 30;

/**
 * Words that already mean something under /portfolio/ or that a person would
 * reasonably read as belonging to the site rather than to an account.
 * `index` and anything with a dot are excluded by the route itself; these are
 * the ones only this check can catch.
 */
const RESERVED_HANDLES = new Set([
  "index", "api", "js", "css", "assets", "static", "img", "images", "fonts",
  "admin", "login", "logout", "signup", "signin", "register", "verify", "reset",
  "profile", "portfolio", "jobs", "experiments", "legal", "shared", "about",
  "terms", "privacy", "contact", "settings", "account", "new", "edit", "search",
  "me", "you", "null", "undefined", "true", "false"
]);

/**
 * Check a requested handle and say why it is refused, or null if it is fine.
 *
 * @param {string} handle already lowercased and trimmed
 * @returns {string|null} the reason to send back, or null when acceptable
 */
export function handleProblem(handle) {
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    return `Your address must be between ${HANDLE_MIN} and ${HANDLE_MAX} characters.`;
  }
  if (!HANDLE_SHAPE.test(handle)) {
    return "Use lowercase letters, numbers and single hyphens, starting and ending with a letter or number.";
  }
  if (RESERVED_HANDLES.has(handle)) {
    return "That address is reserved. Please choose another.";
  }
  return null;
}

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
  /* THEIR row, not row one. It was pinned to id = 1, so a second account would
     have been shown Brian's resume and would have edited it. */
  await readyProfileColumns(env.DB);
  const row = await env.DB.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM profile WHERE user_id = ?1`
  ).bind(user.id).first();
  const stored = row ? readSections(row.profile_sections) : null;
  const profile = row ? { ...row, profile_sections: stored } : null;
  /* The parse is offered, never written. Putting it on the row here is how a
     person's edited title would vanish the next time they opened the page. */
  const suggested = row && row.resume_text ? parseResume(row.resume_text) : null;
  return new Response(JSON.stringify({
    profile,
    suggested,
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
  await readyProfileColumns(env.DB);

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
  /* The handle changes the address of a PUBLIC page, so it is checked for
     shape, for reserved words and for collision before anything is written.
     Compared case-insensitively because the stored value is lowercase and a
     person typing "Magnus" must not be able to claim a second address next to
     an existing "magnus". */
  if ("handle" in body) {
    const wanted = String(body.handle || "").trim().toLowerCase();
    if (!wanted) {
      return new Response(JSON.stringify({ error: "Your portfolio address cannot be empty." }), { status: 400, headers: HEADERS });
    }
    const problem = handleProblem(wanted);
    if (problem) {
      return new Response(JSON.stringify({ error: problem }), { status: 400, headers: HEADERS });
    }
    const taken = await env.DB.prepare(
      "SELECT user_id FROM profile WHERE lower(handle) = ?1 AND user_id <> ?2"
    ).bind(wanted, user.id).first();
    if (taken) {
      return new Response(JSON.stringify({ error: "That address is already taken." }), { status: 409, headers: HEADERS });
    }
    sets.push("handle = ?");
    values.push(wanted);
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
  /* profile_sections is the saved editor state. It is stored as the person
     sent it (after shape-normalising). Re-parsing the resume here and writing
     that instead is the overwrite this column exists to prevent. */
  if ("profile_sections" in body) {
    if (body.profile_sections === null) {
      sets.push("profile_sections = ?");
      values.push(null);
    } else if (typeof body.profile_sections !== "object" || Array.isArray(body.profile_sections)) {
      return new Response(JSON.stringify({ error: "profile_sections must be an object" }), { status: 400, headers: HEADERS });
    } else {
      const normalized = normalizeSections(body.profile_sections);
      const json = JSON.stringify(normalized);
      if (json.length > MAX_SECTIONS_CHARS) {
        return new Response(JSON.stringify({
          error: `profile_sections is too large (${Math.round(json.length / 1024)}KB); keep it under ${Math.round(MAX_SECTIONS_CHARS / 1024)}KB`
        }), { status: 400, headers: HEADERS });
      }
      sets.push("profile_sections = ?");
      values.push(json);
    }
  }
  if (!sets.length) {
    return new Response(JSON.stringify({ error: "nothing to update" }), { status: 400, headers: HEADERS });
  }
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());

  /* The column names come from the EDITABLE allowlist above, never from the
     request; only the VALUES are bound. A field name arriving from the caller
     would be the injection this shape usually has. */
  /* Scoped to the signed-in user. The column names come from the EDITABLE
     allowlist above and never from the request; only the values are bound. */
  values.push(user.id);
  await env.DB.prepare(`UPDATE profile SET ${sets.join(", ")} WHERE user_id = ?`).bind(...values).run();
  const saved = await env.DB.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM profile WHERE user_id = ?1`
  ).bind(user.id).first();
  const profile = saved ? { ...saved, profile_sections: readSections(saved.profile_sections) } : saved;
  return new Response(JSON.stringify({ ok: true, profile }), { headers: HEADERS });
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "GET, PUT, OPTIONS" }
  });
}
