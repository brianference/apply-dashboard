/**
 * WeWorkRemotely descriptions, read from its category feeds.
 *
 * Ten queued rows pointed at weworkremotely.com and none of them had ever had
 * a description read, because the posting page answers 403 to anything that is
 * not a browser. Its category RSS feeds answer 200 and carry the FULL
 * description, around 10KB per item, so the text was always available -- just
 * not where the reader was looking.
 *
 * Six of the ten are in these four categories. The rest have aged out of the
 * feeds, and there is no archive: a feed is a rolling window. Six recovered
 * beats ten refused.
 *
 * The feeds are fetched at most once per process. Each is roughly 170KB, and
 * re-fetching them per URL would download several megabytes to read one row.
 */

/* Product first, because that is where most of his queue lands. The others
   are here because WeWorkRemotely files a product role under whichever
   category the employer picked, and "all other" is where the odd ones go. */
export const WWR_FEEDS = [
  'https://weworkremotely.com/categories/remote-product-jobs.rss',
  'https://weworkremotely.com/categories/remote-management-and-finance-jobs.rss',
  'https://weworkremotely.com/categories/all-other-remote-jobs.rss',
  'https://weworkremotely.com/categories/remote-programming-jobs.rss'
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * The last path segment of a link, which is what a WeWorkRemotely posting is
 * addressed by.
 *
 * @param {string} url
 * @returns {string}
 */
export function slugOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  let pathname;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    /* Not a full URL: treat what was given as a path. */
    pathname = raw.split('?')[0].split('#')[0];
  }
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  /* The PATH, not the whole string. Splitting the raw URL made
     "https://weworkremotely.com" yield "weworkremotely.com" -- a hostname
     presented as a posting slug, which would match a feed entry by accident. */
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Pull `<item>` blocks out of an RSS document into slug and description.
 *
 * Deliberately not an XML parser: the only two fields needed are a link and a
 * description, and adding a dependency to read two tags is not worth it. The
 * CDATA wrapper is stripped because WeWorkRemotely wraps every description in
 * one, and leaving it turns the first 9 characters of every job into "[CDATA[".
 *
 * @param {string} xml
 * @returns {Map<string, string>} slug to description HTML
 */
export function parseFeed(xml) {
  const out = new Map();
  const text = String(xml || '');
  const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items) {
    const link = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const raw = (item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
    const slug = slugOf(link.trim());
    if (!slug || !raw) continue;
    const unwrapped = raw.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
    out.set(slug, unwrapped);
  }
  return out;
}

/**
 * Every feed merged into one slug-to-description map, fetched once.
 *
 * A feed that fails is skipped rather than fatal: three feeds answering is
 * three categories of postings recovered, and refusing all of them because one
 * timed out helps nobody.
 *
 * @param {{ fetch?: Function, feeds?: string[] }} [options]
 * @returns {Promise<Map<string, string>>}
 */
export async function loadFeeds(options = {}) {
  const get = options.fetch || globalThis.fetch.bind(globalThis);
  const feeds = options.feeds || WWR_FEEDS;
  const merged = new Map();
  for (const url of feeds) {
    try {
      const res = await get(url, { headers: { accept: 'application/rss+xml, text/xml, */*', 'user-agent': BROWSER_UA } });
      if (!res || res.status < 200 || res.status >= 300) continue;
      const xml = await res.text();
      for (const [slug, html] of parseFeed(xml)) {
        if (!merged.has(slug)) merged.set(slug, html);
      }
    } catch {
      /* One unreachable category must not cost the other three. */
    }
  }
  return merged;
}

/** Cached for the life of the process; see the note about megabytes above. */
let cached = null;

/**
 * The description for one WeWorkRemotely posting URL, or null.
 *
 * @param {string} url
 * @param {{ fetch?: Function, feeds?: string[], refresh?: boolean }} [options]
 * @returns {Promise<string|null>}
 */
export async function descriptionFor(url, options = {}) {
  if (options.refresh || !cached) cached = await loadFeeds(options);
  const slug = slugOf(url);
  if (!slug) return null;
  return cached.get(slug) || null;
}

/** Forget the cached feeds, so a test can control what is loaded. */
export function resetCache() {
  cached = null;
}
