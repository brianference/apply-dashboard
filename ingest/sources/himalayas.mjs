import { logWarn } from "../logger.mjs";
import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "himalayas",
  name: "Himalayas Remote Jobs API",
  homepage: "https://himalayas.app/docs/remote-jobs-api",
  kind: "remote-board",
  license: "public JSON; no key; attribution requested"
};

const BROWSE_URL = "https://himalayas.app/jobs/api?limit=20";
const SEARCH_URL = "https://himalayas.app/jobs/api/search";

/**
 * Map Himalayas jobs JSON onto the shared posting shape.
 *
 * @param {unknown} payload
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeHimalayasJobs(payload) {
  const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
  return jobs.map((job) => {
    const locations = Array.isArray(job.locationRestrictions)
      ? job.locationRestrictions.map((row) => (row && row.name) || row).filter(Boolean).join(", ")
      : "";
    return {
      company: job && job.companyName ? String(job.companyName) : "Himalayas listing",
      title: job && job.title ? String(job.title) : "",
      url: job && job.applicationLink ? String(job.applicationLink) : "",
      source: "himalayas",
      work_type: joinWorkType(job && job.employmentType, locations),
      posted: isoFromUnknown(job && job.pubDate)
    };
  });
}

/**
 * Fetch Himalayas remote jobs. Uses the search endpoint when a query is given.
 *
 * @param {{ limit?: number, query?: string, alsoTitles?: RegExp }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const query = options.query ? String(options.query).trim() : "";
  let payload;
  if (query) {
    try {
      payload = await fetchJson(`${SEARCH_URL}?q=${encodeURIComponent(query)}`);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (!/HTTP 429/.test(message)) throw error;
      payload = await fetchJson(BROWSE_URL);
    }
  } else {
    payload = await fetchJson(BROWSE_URL);
  }
  const jobs = normalizeHimalayasJobs(payload);
  /* This feed searches on the server, so a "product" search never returns a
     strategist for alsoTitles to keep. A failure here keeps the main search. */
  if (options.alsoTitles) {
    try {
      jobs.push(...normalizeHimalayasJobs(await fetchJson(SEARCH_URL + "?q=deployment%20strategist")));
    } catch (error) {
      logWarn("himalayas strategist search skipped", { error: String(error && error.message ? error.message : error) });
    }
  }
  return filterJobs(jobs, options);
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
