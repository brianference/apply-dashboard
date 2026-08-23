import { loadCompanies } from "../companies.mjs";
import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson, mapPool, settle } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "lever",
  name: "Lever Postings API",
  homepage: "https://github.com/lever/postings-api",
  kind: "ats",
  license: "public postings JSON; no key"
};

const POSTINGS_URL = (token) =>
  `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;

/**
 * Map Lever postings JSON onto the shared posting shape.
 *
 * @param {unknown} payload
 * @param {{ companyName: string }} board
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeLeverJobs(payload, board) {
  const jobs = Array.isArray(payload) ? payload : [];
  const companyName = board && board.companyName ? board.companyName : "";
  return jobs.map((job) => ({
    company: companyName,
    title: job && job.text ? String(job.text) : "",
    url: job && job.hostedUrl ? String(job.hostedUrl) : "",
    source: "lever",
    work_type: joinWorkType(
      job && job.workplaceType,
      job && job.categories && job.categories.location,
      job && job.categories && job.categories.commitment
    ),
    posted: isoFromUnknown(job && job.createdAt)
  }));
}

/**
 * Fetch published postings from every verified Lever site token.
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const companies = (await loadCompanies()).lever;
  const collected = [];
  await mapPool(companies, 4, async (company) => {
    const payload = await settle(
      `lever:${company.token}`,
      () => fetchJson(POSTINGS_URL(company.token)),
      []
    );
    collected.push(...normalizeLeverJobs(payload, { companyName: company.name }));
  });
  return filterJobs(collected, options);
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
