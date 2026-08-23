import { isCli, runSourceCli } from "../cli.mjs";
import { fetchText } from "../http.mjs";
import { filterJobs, joinWorkType } from "../jobs.mjs";
import { parseRssItems, postedFromRss } from "../rss.mjs";

export const meta = {
  id: "weworkremotely",
  name: "We Work Remotely",
  homepage: "https://weworkremotely.com/remote-job-rss-feed",
  kind: "remote-board",
  license: "public RSS; attribution requested"
};

const ALL_JOBS = "https://weworkremotely.com/remote-jobs.rss";
const PRODUCT_JOBS = "https://weworkremotely.com/categories/remote-product-jobs.rss";

/**
 * Map WWR RSS items onto the shared posting shape.
 * Titles are "Company: Role".
 *
 * @param {Array<{ title: string, link: string, pubDate: string, region: string, type: string }>} items
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeWeWorkRemotelyItems(items) {
  return (items || []).map((item) => {
    const rawTitle = item.title || "";
    const split = rawTitle.indexOf(": ");
    const company = split >= 0 ? rawTitle.slice(0, split).trim() : "We Work Remotely listing";
    const title = split >= 0 ? rawTitle.slice(split + 2).trim() : rawTitle;
    return {
      company,
      title,
      url: item.link || item.guid || "",
      source: "weworkremotely",
      work_type: joinWorkType("Remote", item.type, item.region),
      posted: postedFromRss(item.pubDate)
    };
  });
}

/**
 * Fetch the public WWR RSS feed (product category when the query looks like PM).
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const query = options.query ? String(options.query).toLowerCase() : "";
  const url = /\bproduct\b|\bpm\b/.test(query) ? PRODUCT_JOBS : ALL_JOBS;
  const result = await fetchText(url, { accept: "application/rss+xml, application/xml, text/xml" });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`GET ${url} returned HTTP ${result.status}`);
  }
  return filterJobs(normalizeWeWorkRemotelyItems(parseRssItems(result.text)), options);
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
