import { loadCompanies } from "../companies.mjs";
import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson, mapPool, settle } from "../http.mjs";
import { datesFromGreenhouse } from "../board-dates.mjs";
import { filterJobs, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "greenhouse",
  name: "Greenhouse Job Board API",
  homepage: "https://developers.greenhouse.io/job-board.html",
  kind: "ats",
  license: "public job-board JSON; no key"
};

const BOARD_URL = (token) =>
  `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`;

/**
 * Map Greenhouse list-jobs JSON onto the shared posting shape.
 *
 * @param {unknown} payload
 * @param {{ companyName: string }} board
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null, refreshed_at: string|null }>}
 */
export function normalizeGreenhouseJobs(payload, board) {
  const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
  const companyName = board && board.companyName ? board.companyName : "";
  return jobs.map((job) => {
    const dates = datesFromGreenhouse(job);
    return {
      company: (job && job.company_name) || companyName,
      title: job && job.title ? String(job.title) : "",
      url: job && job.absolute_url ? String(job.absolute_url) : "",
      source: "greenhouse",
      work_type: joinWorkType(job && job.location && job.location.name),
      posted: dates.posted,
      refreshed_at: dates.refreshed_at
    };
  });
}

/**
 * Fetch published postings from every verified Greenhouse board token.
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null, refreshed_at: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const companies = (await loadCompanies()).greenhouse;
  const collected = [];
  await mapPool(companies, 4, async (company) => {
    const payload = await settle(
      `greenhouse:${company.token}`,
      () => fetchJson(BOARD_URL(company.token)),
      { jobs: [] }
    );
    collected.push(...normalizeGreenhouseJobs(payload, { companyName: company.name }));
  });
  return filterJobs(collected, options);
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
