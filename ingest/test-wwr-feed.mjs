/**
 * WeWorkRemotely descriptions, read from the category feeds.
 *
 * Ten queued rows pointed at weworkremotely.com and not one had ever had a
 * description read. The posting page answers 403 to anything that is not a
 * browser, so the reader gave up; the category RSS feeds answer 200 and carry
 * the whole description. The text was always available and the reader was
 * looking in the wrong place.
 *
 * Six of the ten are in the feeds. The rest have aged out, and a feed is a
 * rolling window with no archive -- which is why an aged-out posting must come
 * back as UNREADABLE rather than as closed. Calling it closed would retire a
 * job that is still open, and a wrongly-retired row is worse than a wrongly-
 * kept one.
 *
 *   node ingest/test-wwr-feed.mjs
 */

import { parseFeed, slugOf, loadFeeds, descriptionFor, resetCache, WWR_FEEDS } from './wwr-feed.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(70)} ${detail || ''}`);
}

/* Shaped like the real feed: WeWorkRemotely wraps every description in CDATA
   and the link is the posting URL. */
const FEED = `<?xml version="1.0"?><rss><channel>
<item>
  <title>Versapay: Senior Product Manager</title>
  <link>https://weworkremotely.com/remote-jobs/versapay-senior-product-manager-payments</link>
  <description><![CDATA[<p>We are hiring a Senior Product Manager.</p><p>The salary range for this role is $165,000 - $180,000 USD.</p>]]></description>
</item>
<item>
  <title>Nucs AI: Senior Product Manager</title>
  <link>https://weworkremotely.com/remote-jobs/nucs-ai-senior-product-manager/</link>
  <description><![CDATA[<p>Own the roadmap end to end.</p>]]></description>
</item>
</channel></rss>`;

/* ------------------------------------------------------------ the parser -- */

const parsed = parseFeed(FEED);
check('both items are read out of the feed', parsed.size === 2, `${parsed.size} items`);
/* Leaving the CDATA wrapper on turns the first characters of every job into
   "[CDATA[", which reads as a broken description rather than as a bug. */
check('the CDATA wrapper is stripped',
  !String(parsed.get('versapay-senior-product-manager-payments')).includes('CDATA'),
  String(parsed.get('versapay-senior-product-manager-payments')).slice(0, 40));
check('the description keeps its markup for the text extractor',
  String(parsed.get('nucs-ai-senior-product-manager')).includes('roadmap'));
check('a trailing slash on the link does not change the slug',
  parsed.has('nucs-ai-senior-product-manager'));
check('an empty document parses to nothing, rather than throwing',
  parseFeed('').size === 0 && parseFeed(null).size === 0);
check('a feed with no description on an item skips that item',
  parseFeed('<item><link>https://x/y/z</link></item>').size === 0);

check('a slug ignores query and fragment',
  slugOf('https://weworkremotely.com/remote-jobs/abc-def?utm=1#top') === 'abc-def');
check('and is lowercased, so a link that differs only in case still matches',
  slugOf('https://weworkremotely.com/remote-jobs/ABC-Def') === 'abc-def');
/* The hostname is not a posting slug. Splitting the raw URL rather than its
   path returned "weworkremotely.com" here, which could match a feed entry by
   accident. */
check('a url with no path gives no slug at all',
  slugOf('https://weworkremotely.com') === '' && slugOf('https://weworkremotely.com/') === '',
  JSON.stringify(slugOf('https://weworkremotely.com')));

/* -------------------------------------------------------------- fetching -- */

/**
 * @param {Record<string, {status?: number, body?: string, throws?: boolean}>} plan
 */
function fakeFetch(plan) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const entry = plan[url];
    if (!entry) return { status: 404, text: async () => '' };
    if (entry.throws) throw new Error('network');
    return { status: entry.status || 200, text: async () => entry.body || '' };
  };
  return { fn, calls };
}

resetCache();
const all = fakeFetch(Object.fromEntries(WWR_FEEDS.map((u) => [u, { body: FEED }])));
const merged = await loadFeeds({ fetch: all.fn });
check('every category feed is fetched', all.calls.length === WWR_FEEDS.length,
  `${all.calls.length} of ${WWR_FEEDS.length}`);
check('and the results merge into one lookup', merged.size === 2, `${merged.size} entries`);

/* One category failing must not cost the other three. Three feeds answering is
   three categories of postings recovered. */
resetCache();
const partial = fakeFetch({
  [WWR_FEEDS[0]]: { throws: true },
  [WWR_FEEDS[1]]: { status: 503 },
  [WWR_FEEDS[2]]: { body: FEED },
  [WWR_FEEDS[3]]: { body: FEED }
});
const survived = await loadFeeds({ fetch: partial.fn });
check('a throwing feed and a 503 do not stop the others',
  survived.size === 2, `${survived.size} entries from ${partial.calls.length} feeds`);

resetCache();
const cachedFetch = fakeFetch(Object.fromEntries(WWR_FEEDS.map((u) => [u, { body: FEED }])));
await descriptionFor('https://weworkremotely.com/remote-jobs/nucs-ai-senior-product-manager', { fetch: cachedFetch.fn });
await descriptionFor('https://weworkremotely.com/remote-jobs/versapay-senior-product-manager-payments', { fetch: cachedFetch.fn });
/* Each feed is around 170KB. Re-fetching per URL would pull megabytes down to
   read one row. */
check('the feeds are fetched once, not once per posting',
  cachedFetch.calls.length === WWR_FEEDS.length, `${cachedFetch.calls.length} fetches for 2 lookups`);

resetCache();
const one = fakeFetch(Object.fromEntries(WWR_FEEDS.map((u) => [u, { body: FEED }])));
const found = await descriptionFor('https://weworkremotely.com/remote-jobs/versapay-senior-product-manager-payments', { fetch: one.fn });
check('a posting in the feed comes back with its description',
  typeof found === 'string' && found.includes('165,000'), String(found).slice(0, 50));
/* A posting that has aged out is UNREADABLE, not gone. */
check('a posting that is not in any feed returns null rather than an empty string',
  await descriptionFor('https://weworkremotely.com/remote-jobs/aged-out-long-ago', { fetch: one.fn }) === null);

console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe feeds parse, one failing category does not cost the others, and an aged-out posting is null rather than empty');
process.exitCode = bad ? 1 : 0;
