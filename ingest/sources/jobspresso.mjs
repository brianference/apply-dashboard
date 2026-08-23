import { isCli, runSourceCli } from "../cli.mjs";
import { fetchText } from "../http.mjs";
import { filterJobs, joinWorkType } from "../jobs.mjs";
import { parseRssItems, postedFromRss } from "../rss.mjs";

export const meta = {
  id: "jobspresso",
  name: "Jobspresso",
  homepage: "https://jobspresso.co/remote-work/",
  kind: "remote-board",
  license: "public WordPress job_listing RSS"
};

const FEED_URL = "https://jobspresso.co/feed/?post_type=job_listing";

/**
 * @param {string} creator
 * @returns {string}
 */
function companyFromCreator(creator) {
  const first = String(creator || "").split(/<br\s*\/?>/i)[0];
  const text = first.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || "Jobspresso listing";
}

/**
 * Map Jobspresso RSS items onto the shared posting shape.
 *
 * @param {Array<{ title: string, link: string, pubDate: string, creator: string }>} items
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>}
 */
export function normalizeJobspressoItems(items) {
  return (items || []).map((item) => ({
    company: companyFromCreator(item.creator),
    title: item.title || "",
    url: item.link || item.guid || "",
    source: "jobspresso",
    work_type: joinWorkType("Remote"),
    posted: postedFromRss(item.pubDate)
  }));
}

/**
 * Fetch the public Jobspresso job_listing RSS feed.
 *
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const result = await fetchText(FEED_URL, { accept: "application/rss+xml, application/xml, text/xml" });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`GET ${FEED_URL} returned HTTP ${result.status}`);
  }
  return filterJobs(normalizeJobspressoItems(parseRssItems(result.text)), options);
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
