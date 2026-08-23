import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "remoteok",
  name: "Remote OK",
  homepage: "https://remoteok.com/",
  kind: "remote-board",
  license: "public JSON at /api; attribution required"
};

const API_URL = "https://remoteok.com/api";

/**
 * Map Remote OK /api JSON onto the shared posting shape.
 * The first array element is a legal notice, not a job.
 *
 * @param {unknown} payload
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeRemoteOkJobs(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .filter((row) => row && row.position && (row.url || row.apply_url) && !row.legal)
    .map((row) => ({
      company: row.company ? String(row.company) : "Remote OK listing",
      title: String(row.position),
      url: String(row.url || row.apply_url),
      source: "remoteok",
      work_type: joinWorkType("Remote", row.location, Array.isArray(row.tags) ? row.tags.join(", ") : null),
      posted: isoFromUnknown(row.date || (row.epoch ? Number(row.epoch) : null))
    }));
}

/**
 * Fetch the public Remote OK JSON feed.
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const payload = await fetchJson(API_URL);
  return filterJobs(normalizeRemoteOkJobs(payload), options);
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
