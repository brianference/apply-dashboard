import { isCli, runSourceCli } from "../cli.mjs";
import { fetchText, mapPool } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "remotepmjobs",
  name: "Remote PM Jobs",
  homepage: "https://remotepmjobs.com/",
  kind: "remote-board",
  license: "public sitemap plus schema.org JobPosting markup on every posting"
};

const SITEMAP_URL = "https://remotepmjobs.com/sitemap.xml";
/** How far back a sitemap lastmod may be for the page to be read. */
const DEFAULT_DAYS = 3;
/** Pages fetched at once. The site is small; be a polite reader of it. */
const CONCURRENCY = 4;

/**
 * Brian, 2026-09-16, pointing at a specific Buildout posting on this board and
 * asking for its new rows weekly.
 *
 * The board has no RSS and no JSON API, but it has two things that add up to
 * one. Its sitemap lists every posting with a lastmod, 2,580 URLs of which
 * 1,709 are postings and 335 were touched in the past week. And every posting
 * page carries a schema.org JobPosting block: datePosted, validThrough, an
 * applicantLocationRequirements country, baseSalary when the employer
 * published one, and beside it an outbound apply link to the employer's own
 * ATS. So the sitemap is the index and the JSON-LD is the record.
 *
 * The URL stored is the EMPLOYER'S, not remotepmjobs.com's, with the board's
 * tracking parameters removed. Two reasons. The duplicate checks in decide()
 * match on URL, and the same Ashby posting must not enter twice because two
 * boards list it. And the link check reads the destination, which is the only
 * page that knows whether the role is still open.
 */

/**
 * Posting URLs whose sitemap lastmod is within `days` of now.
 *
 * @param {string} xml
 * @param {number} days
 * @param {number} [now]
 * @returns {Array<{ url: string, lastmod: string }>}
 */
export function recentPostingUrls(xml, days = DEFAULT_DAYS, now = Date.now()) {
  const out = [];
  const re = /<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g;
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) {
    const url = m[1].trim();
    const lastmod = (m[2] || "").trim();
    /* Posting pages live at /companies/<slug>/<title-slug-uuid>; company pages
       stop one segment short. */
    if (!/^https:\/\/remotepmjobs\.com\/companies\/[^/]+\/[^/]+$/.test(url)) continue;
    const t = Date.parse(lastmod);
    if (!Number.isFinite(t)) continue;
    if (now - t > days * 86400000) continue;
    out.push({ url, lastmod });
  }
  return out;
}

/**
 * The JobPosting record and the employer's apply link from one posting page.
 *
 * Returns null when the page has no JobPosting block or no outbound apply link,
 * because a row without the employer's URL cannot be deduplicated against the
 * boards and cannot be link-checked.
 *
 * @param {string} html
 * @returns {{ company: string, title: string, url: string, work_type: string|null, posted: string|null, salary_min: number|null, salary_max: number|null }|null}
 */
export function parsePosting(html) {
  const text = String(html || "");
  let posting = null;
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const d = JSON.parse(m[1]);
      if (d && d["@type"] === "JobPosting") { posting = d; break; }
    } catch {
      /* Not every block on the page is a JobPosting, and not every one parses. */
    }
  }
  if (!posting || !posting.title) return null;

  /* The apply link is the first outbound href that is not the board itself,
     a social profile or a badge. The board appends utm_* to it; those are
     stripped so the URL matches what the employer's own board would give. */
  const hrefs = [...text.matchAll(/href="(https?:\/\/(?!remotepmjobs\.com)[^"]+)"/g)]
    .map((x) => x[1].replace(/&amp;/g, "&"))
    .filter((h) => !/linkedin\.com|twitter\.com|x\.com|facebook\.com|scrolllaunch|fonts\.|cdn\.|logo|stripe/i.test(h));
  if (!hrefs.length) return null;
  const apply = new URL(hrefs[0]);
  for (const key of [...apply.searchParams.keys()]) {
    if (/^utm_/i.test(key) || key === "ref") apply.searchParams.delete(key);
  }

  const org = posting.hiringOrganization && posting.hiringOrganization.name;
  const req = posting.applicantLocationRequirements;
  const country = Array.isArray(req) ? req.map((r) => r && r.name).filter(Boolean).join(", ") : (req && req.name) || null;
  const salary = posting.baseSalary && posting.baseSalary.value;
  const min = salary && salary.minValue != null ? Number(salary.minValue) : null;
  const max = salary && salary.maxValue != null ? Number(salary.maxValue) : null;

  return {
    company: org ? String(org) : "Remote PM Jobs listing",
    title: String(posting.title).trim(),
    url: apply.toString(),
    /* TELECOMMUTE is schema.org's word for remote. The country restriction is
       what the location gate reads, so it rides along. */
    work_type: joinWorkType(
      posting.jobLocationType === "TELECOMMUTE" ? "Remote" : null,
      country,
      posting.employmentType || null
    ),
    posted: isoFromUnknown(posting.datePosted),
    salary_min: Number.isFinite(min) ? min : null,
    salary_max: Number.isFinite(max) ? max : null
  };
}

/**
 * Read the sitemap, then the pages touched recently.
 *
 * @param {{ limit?: number, query?: string, days?: number }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const days = Number(options.days) > 0 ? Number(options.days) : DEFAULT_DAYS;
  /* fetchText returns { text, status, ... }, not a string. The first run of
     this file passed the object straight to the parser, which matched nothing
     and returned zero rows without a word: an empty result that looked exactly
     like a quiet week. So a sitemap that yields no posting URLs at all now
     throws, because that board has 1,700 of them and zero means the reader is
     broken, not that nothing was posted. */
  const sitemap = await fetchText(SITEMAP_URL);
  const recent = recentPostingUrls(sitemap.text, days);
  if (!recent.length && !/<loc>/.test(sitemap.text || "")) {
    throw new Error(`remotepmjobs sitemap returned no <loc> entries (HTTP ${sitemap.status}, ${String(sitemap.text || "").length} bytes)`);
  }
  const pages = await mapPool(recent, CONCURRENCY, async ({ url }) => {
    try {
      const page = await fetchText(url, { accept: "text/html,*/*;q=0.8" });
      return parsePosting(page.text);
    } catch {
      return null;
    }
  });
  const rows = pages.filter(Boolean).map((r) => ({ ...r, source: "remotepmjobs" }));
  return filterJobs(rows, { limit: options.limit });
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
