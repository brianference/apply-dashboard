import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";
import { locationEligible } from "../location-eligible.mjs";

export const meta = {
  id: "amazon",
  name: "Amazon",
  homepage: "https://www.amazon.jobs/",
  kind: "employer",
  license: "the JSON behind the public search page at amazon.jobs"
};

const BASE_URL = "https://www.amazon.jobs";
const SEARCH_URL = `${BASE_URL}/en/search.json`;
const PAGE_SIZE = 100;
/* 464 rows matched on 2026-11-05. The cap stops a runaway loop, not the search. */
const MAX_ROWS = 2000;

/**
 * Every location on a posting, because a role listed in Seattle can also be
 * offered in Tempe and normalized_location names only one of them. Each entry is
 * a JSON string; one that does not parse is skipped rather than losing the row.
 *
 * @param {{ locations?: unknown, normalized_location?: unknown, location?: unknown }} row
 * @returns {string[]}
 */
function locationsOf(row) {
  const places = [];
  for (const entry of Array.isArray(row.locations) ? row.locations : []) {
    try {
      const place = typeof entry === "string" ? JSON.parse(entry) : entry;
      if (place && place.normalizedLocation) places.push(String(place.normalizedLocation));
    } catch {
      continue;
    }
  }
  if (places.length) return places;
  return [row.normalized_location || row.location].filter(Boolean).map(String);
}

/**
 * The company is always Amazon: company_name holds the legal entity, such as
 * "Amazon Kuiper Commercial Services LLC", which would split one employer in two.
 *
 * @param {unknown} payload
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeAmazonJobs(payload) {
  const rows = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
  return rows
    .filter((row) => row && row.title && row.job_path)
    .map((row) => ({
      company: "Amazon",
      title: String(row.title),
      url: `${BASE_URL}${row.job_path}`,
      source: "amazon",
      work_type: joinWorkType(...locationsOf(row)),
      posted: isoFromUnknown(row.posted_date)
    }));
}

/**
 * Fetch US product manager postings, newest first. The search is fixed rather
 * than taken from options.query, because the daily run asks every source for
 * "product", which here would also return roles the role rule refuses anyway.
 *
 * @param {{ limit?: number, query?: string, alsoTitles?: RegExp }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const collected = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const payload = await fetchJson(`${SEARCH_URL}?base_query=product+manager&country=USA&result_limit=${PAGE_SIZE}&offset=${offset}&sort=recent`);
    const page = normalizeAmazonJobs(payload);
    if (!page.length) break;
    collected.push(...page);
  }
  /* Filtered here because buildRows keeps the first row per company and title and
     decide() gates afterwards, so a Seattle row would shadow the same title in
     Tempe. 17 of 389 rows shared a title on 2026-11-05. */
  return filterJobs(collected.filter((job) => locationEligible(job.work_type, job.title, job.company).ok), options);
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
