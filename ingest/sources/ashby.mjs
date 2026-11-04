import { loadCompanies } from "../companies.mjs";
import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson, mapPool, settle } from "../http.mjs";
import { datesFromAshby } from "../board-dates.mjs";
import { filterJobs, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "ashby",
  name: "Ashby Job Postings API",
  homepage: "https://developers.ashbyhq.com/docs/public-job-posting-api",
  kind: "ats",
  license: "public job-board JSON; no key"
};

const BOARD_URL = (token) =>
  `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;

const US_WORDS = /\b(?:usa?|u\.s\.?|united states)(?![a-z])/gi;

/**
 * Does this secondary location offer remote work from anywhere in the US?
 *
 * Cerebras "Senior Product Manager, AI Models" is workplaceType Hybrid in
 * Sunnyvale with a secondary location of "Remote (US)", and the description
 * says remote is possible. The location gate never saw the secondary field, so
 * it read as a Sunnyvale hybrid. Only a location that names the whole US and
 * nothing else counts: "Remote - United States - Texas" and "Remote - CST" are
 * fences, and bare "Remote" on a hybrid posting says nothing about where.
 *
 * @param {unknown} location
 * @returns {boolean}
 */
export function isUsWideRemote(location) {
  const text = String(location || "");
  if (!/\bremote\b/i.test(text)) return false;
  const rest = text.replace(/\b(?:remote|available|only)\b/gi, " ");
  if (!rest.match(US_WORDS)) return false;
  return !/[a-z]/i.test(rest.replace(US_WORDS, " "));
}

/**
 * Map Ashby job-board JSON onto the shared posting shape.
 *
 * @param {unknown} payload
 * @param {{ companyName: string }} board
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null, refreshed_at: string|null }>}
 */
export function normalizeAshbyJobs(payload, board) {
  const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
  const companyName = board && board.companyName ? board.companyName : "";
  return jobs.map((job) => {
    const dates = datesFromAshby(job);
    const secondary = job && Array.isArray(job.secondaryLocations) ? job.secondaryLocations : [];
    const usRemote = secondary.find((entry) => entry && isUsWideRemote(entry.location));
    return {
      company: companyName,
      title: job && job.title ? String(job.title) : "",
      url: job && (job.jobUrl || job.applyUrl) ? String(job.jobUrl || job.applyUrl) : "",
      source: "ashby",
      work_type: usRemote
        ? joinWorkType("Remote", job.employmentType, usRemote.location)
        : joinWorkType(
          job && job.workplaceType,
          job && job.employmentType,
          job && job.location,
          job && job.isRemote ? "Remote" : null
        ),
      posted: dates.posted,
      refreshed_at: dates.refreshed_at
    };
  });
}

/**
 * Fetch published postings from every verified Ashby org token.
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null, refreshed_at: string|null }>>}
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
