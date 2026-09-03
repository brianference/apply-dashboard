/**
 * GET /api/portfolio — the public view of Brian's work.
 *
 * PUBLIC. No session, no cookie, no token. That is deliberate: the portfolio is
 * the thing he can hand to a recruiter.
 *
 * Which is exactly why this route does not simply return the `profile` row.
 * That row holds the full resume text, and the top of that resume carries a
 * phone number and an email address. Sending them to a specific employer inside
 * an application is one thing; publishing them on a page anyone can scrape is
 * another. So this returns a CURATED subset, and strips contact details from
 * the prose it does pass through, rather than trusting that nobody will notice.
 *
 * Binding: DB -> D1 database 10e8a6c0-1fa7-4c33-a007-2044876ce6a7
 */

import { HEADERS } from "./_auth.js";
import {
  ensureProfileColumns,
  normalizeSections,
  publicView,
  personJsonLd,
  stripContact
} from "./_profile-parse.js";

export { stripContact };

/**
 * D1 runner the column guard expects. Same shape as the private profile
 * route -- a second ALTER on a live database is how a deploy against an
 * already-migrated table used to 500.
 *
 * @param {D1Database} db
 * @param {string} sql
 * @returns {Promise<any>}
 */
function d1Run(db, sql) {
  if (/^\s*PRAGMA/i.test(sql) || /^\s*SELECT/i.test(sql)) return db.prepare(sql).all();
  return db.prepare(sql).run();
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

/**
 * The section of the resume between one heading and the next.
 *
 * The resume is plain text with ALL-CAPS headings, so the sections are found
 * rather than hard-coded by line number, which would break the first time he
 * adds a paragraph.
 *
 * @param {string} resume
 * @param {string} heading
 * @returns {string}
 */
export function section(resume, heading) {
  const lines = String(resume || "").split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[A-Z][A-Z ]{3,}$/.test(l.trim()));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * Public, non-fork, described repositories for a GitHub profile URL.
 *
 * Never throws. A rate limit or an outage at GitHub must not turn this page
 * into an error - it degrades to no open-source section.
 *
 * @param {string|null} githubUrl
 * @returns {Promise<Array<{name: string, description: string, html_url: string, language: string|null, pushed_at: string}>>}
 */
async function publicRepos(githubUrl) {
  const login = String(githubUrl || "").replace(/\/+$/, "").split("/").pop();
  if (!login || !/^[A-Za-z0-9-]{1,39}$/.test(login)) return [];
  try {
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed`,
      { headers: { accept: "application/vnd.github+json", "user-agent": "apply-dashboard-portfolio" } }
    );
    if (!res.ok) return [];
    const all = await res.json();
    if (!Array.isArray(all)) return [];
    return all
      .filter((r) => r && !r.fork && r.description)
      .slice(0, 12)
      .map((r) => ({
        name: r.name, description: r.description, html_url: r.html_url,
        language: r.language || null, pushed_at: r.pushed_at
      }));
  } catch {
    return [];
  }
}

/**
 * @param {{env: {DB: D1Database}}} context
 * @returns {Promise<Response>}
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }),
      { status: 500, headers: HEADERS });
  }
  try {
    /* Whose portfolio is being asked for. `?u=<handle>` names one; with no
       handle it falls back to the first profile ever created, which keeps every
       existing link to /portfolio/ working. It was pinned to id = 1, so every
       account would have shown the same person's work. */
    const handle = (new URL(request.url).searchParams.get("u") || "").trim().toLowerCase();
    /* Which profile is the owner's. The curated project list lives in the page
       as JavaScript, with screenshots of the owner's own running sites, and it
       was rendered for EVERY handle - so a new account's portfolio showed its
       own name above somebody else's work. The page needs to be told whether
       the profile it is showing is the one those projects belong to. */
    await readyProfileColumns(env.DB);
    const first = await env.DB.prepare("SELECT user_id FROM profile ORDER BY id LIMIT 1").first();
    const row = handle
      ? await env.DB.prepare(
          "SELECT user_id, display_name, handle, headline, location, resume_text, linkedin_url, github_url, avatar_data_url, profile_sections, updated_at FROM profile WHERE lower(handle) = ?1"
        ).bind(handle).first()
      : await env.DB.prepare(
          "SELECT user_id, display_name, handle, headline, location, resume_text, linkedin_url, github_url, avatar_data_url, profile_sections, updated_at FROM profile ORDER BY id LIMIT 1"
        ).first();
    if (!row) {
      return new Response(JSON.stringify({ error: "no profile yet" }), { status: 404, headers: HEADERS });
    }

    const resume = row.resume_text || "";
    /* GitHub is fetched HERE, not in the browser.
       The page's CSP is connect-src 'self', so a fetch to api.github.com from
       the client is blocked and logs an error on every single load. Widening
       the policy to admit a third-party host on a public page is the wrong
       trade; fetching server-side keeps it strict, and it also means the
       unauthenticated rate limit is spent once per edge cache rather than once
       per visitor. A failure here returns an empty list and the section simply
       does not render. */
    const repos = await publicRepos(row.github_url);

    /* Saved sections are the public source of truth. The parse of resume_text
       is never applied here -- publishing a suggestion the person has not
       accepted is how an edited title would reappear on the recruiter page. */
    const stored = readSections(row.profile_sections);
    const published = stored ? publicView(stored) : null;
    const vis = published && published.visibility ? published.visibility : null;

    const fallbackSummary = stripContact(section(resume, "SUMMARY"));
    const fallbackSkills = stripContact(section(resume, "SKILLS"));
    const fallbackEducation = stripContact(section(resume, "EDUCATION"));
    const fallbackCerts = stripContact(section(resume, "CERTIFICATIONS"));

    const headerOn = !vis || vis.header !== false;
    const summary = published
      ? (vis.about && published.about ? published.about.text : "")
      : fallbackSummary;
    const skills = published
      ? (vis.skills ? published.skills : null)
      : fallbackSkills;
    const education = published
      ? (vis.education ? published.education : null)
      : fallbackEducation;
    const certifications = published
      ? (vis.certifications ? published.certifications : null)
      : fallbackCerts;
    const experience = published && vis.experience ? published.experience : null;
    const projects = published && vis.projects ? published.projects : null;

    const links = {
      linkedin: headerOn ? (row.linkedin_url || null) : null,
      github: headerOn ? (row.github_url || null) : null
    };
    const name = headerOn ? (row.display_name || null) : null;
    const headline = headerOn ? (row.headline || null) : null;
    const location = headerOn ? (row.location || null) : null;
    const avatar = headerOn ? (row.avatar_data_url || null) : null;

    const pageUrl = row.handle
      ? `https://apply-dashboard.pages.dev/portfolio/${encodeURIComponent(row.handle)}`
      : "https://apply-dashboard.pages.dev/portfolio/";

    const jsonld = personJsonLd({
      name,
      headline,
      location,
      url: pageUrl,
      links,
      experience: experience || [],
      education: Array.isArray(education)
        ? education
        : String(education || "").split("\n").filter(Boolean).map((line) => ({
          line, parts: line.includes(" | ") ? line.split(" | ").map((p) => p.trim()) : [line]
        }))
    });

    return new Response(JSON.stringify({
      /* Name and headline are public by intent. Phone and email are not, and
         are never selected from the row above. The name is a COLUMN now: it was
         a string literal in two different endpoints, which is a fact with no
         source and two places to drift. */
      name,
      handle: row.handle || null,
      /* True only for the profile the built-in project list belongs to. */
      owner: !!(first && row.user_id && first.user_id === row.user_id),
      /* The photo is public on a portfolio by intent; the phone number and the
         address are not, and are never selected. */
      avatar,
      headline,
      location,
      summary,
      skills,
      education,
      certifications,
      experience,
      projects,
      jsonld,
      links,
      repos,
      updated_at: row.updated_at
    }), { headers: { ...HEADERS, "cache-control": "public, max-age=300" } });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "read failed", detail: String((error && error.message) || error) }),
      { status: 500, headers: HEADERS });
  }
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "GET" }
  });
}
