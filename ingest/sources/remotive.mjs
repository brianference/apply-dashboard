import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "remotive",
  name: "Remotive",
  homepage: "https://remotive.com/",
  kind: "remote-board",
  license: "public JSON at /api/remote-jobs; attribution required"
};

const API_URL = "https://remotive.com/api/remote-jobs";

/**
 * Remotive publishes an explicit eligibility field, and it is the reason this
 * source is worth having: "Remote does not always mean worldwide."
 * `candidate_required_location` on the row above reads
 * "France, Japan, Turkey, Vietnam, Mexico, Norway" for a job no US applicant can
 * take. That string is carried into work_type so the location gate reads it
 * rather than assuming remote means reachable.
 *
 * @param {unknown} payload
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeRemotiveJobs(payload) {
  const rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.jobs) ? payload.jobs : []);
  return rows
    .filter((row) => row && row.title && row.url)
    .map((row) => ({
      company: row.company_name ? String(row.company_name) : "Remotive listing",
      title: String(row.title),
      url: String(row.url),
      source: "remotive",
      /* Eligibility first, then the tags, because the gate reads this string. */
      work_type: joinWorkType(
        "Remote",
        row.candidate_required_location,
        row.job_type,
        Array.isArray(row.tags) ? row.tags.join(", ") : null
      ),
      posted: isoFromUnknown(row.publication_date)
    }));
}

/**
 * Fetch the public Remotive feed.
 *
 * The API caps a response at about 16 rows for a search, so the query is passed
 * through rather than pulling everything and filtering here.
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const search = options.query ? `?search=${encodeURIComponent(options.query)}` : "?category=product";
  const payload = await fetchJson(`${API_URL}${search}`);
  /* Only the limit goes on. Filtering by the query a second time here discarded
     a "Facets Product Consultant (Remote)" on another board, because the row's
     words are not the query's words. */
  return filterJobs(normalizeRemotiveJobs(payload), { limit: options.limit });
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
