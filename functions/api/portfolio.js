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

/** Written this way so no build or shell step can mangle an escape into a real break. */
const NEWLINE = String.fromCharCode(10);

/**
 * Remove anything that could be used to contact him directly.
 *
 * Belt and braces: the summary this runs over is chosen by section, so it
 * should never contain the header line in the first place. If the resume is
 * ever re-parsed with different section boundaries, this is what stops the
 * phone number arriving on a public page anyway.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripContact(text) {
  return String(text || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "")
    .replace(/\+?\d{0,2}[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/g, "")
    /* Tidy each line SEPARATELY, and keep the line breaks.
       The first version collapsed `\s{2,}` across the whole string, and `\s`
       includes a newline: the SKILLS lines begin with a leading space, so
       "newline + space" matched and the entire section arrived as one flat
       paragraph with its category labels gone. */
    .split(NEWLINE)
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .filter((line, i, all) => line !== "" || (i > 0 && i < all.length - 1))
    .join(NEWLINE)
    .trim();
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
  const { env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }),
      { status: 500, headers: HEADERS });
  }
  try {
    const row = await env.DB.prepare(
      "SELECT headline, location, resume_text, linkedin_url, github_url, updated_at FROM profile WHERE id = 1"
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
    return new Response(JSON.stringify({
      /* Name and headline are public by intent. Phone and email are not, and
         are never selected from the row above. */
      name: "Brian Ference",
      headline: row.headline || null,
      location: row.location || null,
      summary: stripContact(section(resume, "SUMMARY")),
      skills: stripContact(section(resume, "SKILLS")),
      education: stripContact(section(resume, "EDUCATION")),
      certifications: stripContact(section(resume, "CERTIFICATIONS")),
      links: {
        linkedin: row.linkedin_url || null,
        github: row.github_url || null
      },
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
