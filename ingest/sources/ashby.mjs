import { loadCompanies } from "../companies.mjs";
import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson, mapPool, settle } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "ashby",
  name: "Ashby Job Postings API",
  homepage: "https://developers.ashbyhq.com/docs/public-job-posting-api",
  kind: "ats",
  license: "public job-board JSON; no key"
};

const BOARD_URL = (token) =>
  `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;

/**
 * Map Ashby job-board JSON onto the shared posting shape.
 *
 * @param {unknown} payload
 * @param {{ companyName: string }} board
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeAshbyJobs(payload, board) {
  const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
  const companyName = board && board.companyName ? board.companyName : "";
  return jobs.map((job) => ({
    company: companyName,
    title: job && job.title ? String(job.title) : "",
    url: job && (job.jobUrl || job.applyUrl) ? String(job.jobUrl || job.applyUrl) : "",
    source: "ashby",
    work_type: joinWorkType(
      job && job.workplaceType,
      job && job.employmentType,
      job && job.location,
      job && job.isRemote ? "Remote" : null
    ),
    posted: isoFromUnknown(job && job.publishedAt)
  }));
}

/**
 * Fetch published postings from every verified Ashby org token.
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const companies = (await loadCompanies()).ashby;
  const collected = [];
  await mapPool(companies, 4, async (company) => {
    const payload = await settle(
      `ashby:${company.token}`,
      () => fetchJson(BOARD_URL(company.token)),
      { jobs: [] }
    );
    collected.push(...normalizeAshbyJobs(payload, { companyName: company.name }));
  });
  return filterJobs(collected, options);
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
