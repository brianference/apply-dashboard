import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "workingnomads",
  name: "Working Nomads",
  homepage: "https://www.workingnomads.com/",
  kind: "remote-board",
  license: "public JSON at /api/exposed_jobs/"
};

const API_URL = "https://www.workingnomads.com/api/exposed_jobs/";

/**
 * Working Nomads was already in the database with 44 rows and was NOT in the
 * daily list, so those came from a one-off run and the feed had been silent for
 * 22 days. This makes it continuous.
 *
 * Its `location` is the eligibility field, and "Worldwide" is the common value.
 * It goes into work_type so the location gate reads it rather than treating
 * every remote row as reachable from Arizona.
 *
 * @param {unknown} payload
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeWorkingNomadsJobs(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.results) ? payload.results : []);
  return rows
    .filter((row) => row && row.title && row.url)
    .map((row) => ({
      company: row.company_name ? String(row.company_name) : "Working Nomads listing",
      title: String(row.title),
      url: String(row.url),
      source: "workingnomads",
      work_type: joinWorkType("Remote", row.location, row.category_name, row.tags),
      posted: isoFromUnknown(row.pub_date)
    }));
}

/**
 * Fetch the public Working Nomads feed.
 *
 * The endpoint takes no query, returning every current row, so the query is not
 * forwarded and the caller's own gate does the selecting.
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const payload = await fetchJson(API_URL);
  return filterJobs(normalizeWorkingNomadsJobs(payload), { limit: options.limit });
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
