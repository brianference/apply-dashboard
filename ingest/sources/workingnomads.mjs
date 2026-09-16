import { isCli, runSourceCli } from "../cli.mjs";
import { fetchText } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "workingnomads",
  name: "Working Nomads",
  homepage: "https://www.workingnomads.com/",
  kind: "remote-board",
  license: "the search index the category pages query; no auth, no key"
};

/**
 * The index behind the site's own category pages.
 *
 * The first version of this source read /api/exposed_jobs/, and it was wired
 * into the daily run on that basis. Measured on 2026-09-16, that endpoint is
 * exactly the 53 rows with premium: true, the employer-paid listings, and it
 * held ZERO product-manager rows. The category page the reader actually sees
 * queries this index instead: 5,616 live jobs, 224 matching "product manager",
 * 59 of them from the past week. So the daily run was reading 0 of 59.
 *
 * The body below is the one the page's own jobs.js sends, copied rather than
 * invented. Matching on title, description and company is the site's choice;
 * decide() applies the role rule on the title afterwards, so a description
 * that merely mentions product managers does not get through.
 */
const SEARCH_URL = "https://www.workingnomads.com/jobsapi/_search";
const QUERY_BODY = {
  query: { bool: { must: { query_string: { query: "\"product manager\"", fields: ["title^2", "description", "company"] } } } },
  min_score: 2,
  sort: [{ premium: { order: "desc" } }, { pub_date: { order: "desc" } }],
  size: 300,
  track_total_hits: true
};

/**
 * Map the index's hits onto the shared posting shape.
 *
 * `apply_url` is the employer's own posting, which is what gets stored: the
 * duplicate checks match on URL, and the same Greenhouse posting must not
 * enter twice because two boards list it. The board's own page is not kept.
 *
 * `locations` is the eligibility field and what the gate reads. "Worldwide"
 * and "USA" are the common values; "UK" alone, as on the first hit measured,
 * has to reach the gate and be refused there.
 *
 * `pub_date` is the BOARD's ingest date, not the employer's. It is stored as
 * posted because it is the only date the index has; the daily run's board-date
 * pass re-reads Greenhouse, Ashby and Lever rows from the employer afterwards.
 *
 * @param {unknown} payload
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeWorkingNomadsJobs(payload) {
  const hits = payload && payload.hits && Array.isArray(payload.hits.hits)
    ? payload.hits.hits
    : Array.isArray(payload) ? payload : [];
  return hits
    .map((h) => (h && h._source) ? h._source : h)
    .filter((row) => row && row.title && (row.apply_url || row.url) && !row.expired)
    .map((row) => ({
      company: row.company ? String(row.company) : "Working Nomads listing",
      title: String(row.title),
      url: String(row.apply_url || row.url),
      source: "workingnomads",
      work_type: joinWorkType(
        "Remote",
        Array.isArray(row.locations) ? row.locations.join(", ") : row.locations,
        row.category_name,
        row.position_type
      ),
      posted: isoFromUnknown(row.pub_date),
      salary_min: Number.isFinite(Number(row.annual_salary_usd)) && Number(row.annual_salary_usd) > 0
        ? Number(row.annual_salary_usd) : null,
      salary_max: null
    }));
}

/**
 * Query the index the category page queries.
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const res = await fetchText(SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(QUERY_BODY),
    accept: "application/json"
  });
  const payload = JSON.parse(res.text);
  const rows = normalizeWorkingNomadsJobs(payload);
  /* An index that answers with no hits at all means the query shape changed,
     not that nobody posted: it holds 224 product-manager rows today. */
  if (!rows.length && !(payload.hits && payload.hits.total)) {
    throw new Error(`workingnomads search returned no hits (HTTP ${res.status})`);
  }
  return filterJobs(rows, { limit: options.limit });
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
