import { isCli, runSourceCli } from "../cli.mjs";

export const meta = {
  id: "indeed",
  name: "Indeed",
  homepage: "https://www.indeed.com/",
  kind: "aggregator",
  license: "no working public feed found; see SOURCES-VERIFIED.md"
};

/**
 * Indeed has no working public source from this environment.
 * RSS, the publisher API, and third-party republishers were tried; none
 * returned Indeed postings. This function always throws.
 *
 * @param {{ limit?: number, query?: string }} [_options]
 * @returns {Promise<never>}
 */
export async function fetchJobs(_options = {}) {
  throw new Error("no working Indeed source — see SOURCES-VERIFIED.md");
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
