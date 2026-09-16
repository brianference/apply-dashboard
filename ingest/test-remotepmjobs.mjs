/**
 * Remote PM Jobs: the sitemap is the index, the JSON-LD is the record, and the
 * URL that gets stored is the employer's.
 *
 * Brian, 2026-09-16: a specific Buildout posting on this board, and its new
 * rows weekly.
 *
 * The two things that would silently go wrong are both about identity. If the
 * board's own URL were stored instead of the employer's, the same Ashby posting
 * would enter twice, once from each board, and the link check would read a
 * page that does not know whether the role is open. And if the board's tracking
 * parameters stayed on the URL, decide()'s URL match would miss the duplicate
 * the same way. So most of the cases below are about the URL coming out clean.
 *
 * Run: node ingest/test-remotepmjobs.mjs
 */

import { recentPostingUrls, parsePosting } from './sources/remotepmjobs.mjs';
import { locationEligible } from './location-eligible.mjs';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(66)} ${detail ?? ''}`);
};

const NOW = Date.parse('2026-09-16T20:00:00Z');

/* --------------------------------------------------------------- sitemap -- */

const SITEMAP = `<?xml version="1.0"?><urlset>
<url><loc>https://remotepmjobs.com/</loc><lastmod>2026-09-16</lastmod></url>
<url><loc>https://remotepmjobs.com/companies/openrouter</loc><lastmod>2026-09-16</lastmod></url>
<url><loc>https://remotepmjobs.com/companies/openrouter/product-manager-agent-platform-e435fa90</loc><lastmod>2026-09-16</lastmod></url>
<url><loc>https://remotepmjobs.com/companies/zoom/lead-product-manager-9c24bbd2</loc><lastmod>2026-09-15</lastmod></url>
<url><loc>https://remotepmjobs.com/companies/buildout/senior-product-manager-ai-54941969</loc><lastmod>2026-07-24</lastmod></url>
<url><loc>https://remotepmjobs.com/companies/nodate/some-role-abc</loc></url>
</urlset>`;

const recent = recentPostingUrls(SITEMAP, 3, NOW);
check('only posting pages inside the window are returned', recent.length === 2, `${recent.length} of 6 urls`);
check('the company page (one segment short) is not a posting',
  !recent.some((r) => r.url.endsWith('/companies/openrouter')));
check('the site root is not a posting', !recent.some((r) => r.url === 'https://remotepmjobs.com/'));
check('a posting outside the window is left alone', !recent.some((r) => r.url.includes('buildout')));
check('a posting with no lastmod is skipped rather than assumed fresh', !recent.some((r) => r.url.includes('nodate')));
check('a wider window reaches the older posting', recentPostingUrls(SITEMAP, 60, NOW).length === 3);
check('an empty sitemap yields nothing, not a throw', recentPostingUrls('', 3, NOW).length === 0);

/* ---------------------------------------------------------------- posting -- */

const PAGE = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Remote PM Jobs"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting",
 "title":"Product Manager, Agent Platform","datePosted":"2026-09-16","validThrough":"2026-11-15",
 "hiringOrganization":{"@type":"Organization","name":"OpenRouter"},
 "jobLocationType":"TELECOMMUTE","applicantLocationRequirements":{"@type":"Country","name":"Mexico"},
 "employmentType":"FULL_TIME",
 "baseSalary":{"@type":"MonetaryAmount","currency":"USD","value":{"@type":"QuantitativeValue","minValue":190000,"maxValue":240000,"unitText":"YEAR"}}}</script>
</head><body>
<a href="https://resources.openrouter.ai/terms-of-use">terms</a>
<a href="https://www.linkedin.com/in/somebody/">poster</a>
<div><span class="text-[11px] font-semibold">Location</span><span class="text-right text-[13px]">US (CA, CO, FL +14 more)</span></div>
<a href="https://jobs.ashbyhq.com/openrouter/11a8c381?utm_source=remotepmjobs.com&amp;utm_medium=referral&amp;utm_campaign=apply&amp;ref=x" target="_blank" data-umami-event="apply_click" data-apply-button>Apply</a>
<a href="https://www.scrolllaunch.com/products/remote-pm-jobs?utm_source=badge">badge</a>
</body></html>`;

const row = parsePosting(PAGE);
check('the JobPosting block is found even after an Organization block', !!row && row.title === 'Product Manager, Agent Platform', row && row.title);
check('the employer is the hiringOrganization', row && row.company === 'OpenRouter', row && row.company);

/* THE ONES THAT MATTER. */
check('the stored url is the EMPLOYER\'s, not the board\'s',
  row && row.url.startsWith('https://jobs.ashbyhq.com/openrouter/11a8c381'), row && row.url);
check('the board\'s tracking parameters are stripped',
  row && !/utm_|[?&]ref=/.test(row.url), row && row.url);
check('a LinkedIn profile on the page is not mistaken for the apply link',
  row && !row.url.includes('linkedin.com'));
check('the badge link is not mistaken for the apply link',
  row && !row.url.includes('scrolllaunch'));

/* The fixture's JSON-LD says Mexico on purpose, copied from what Flickr's page
   really does while its sidebar says US. The sidebar must win. */
check('the sidebar Location reaches work_type first', row && /^Remote \/ US \(CA, CO, FL \+14 more\)/.test(row.work_type), row && row.work_type);
check('a body link ahead of the apply button is not mistaken for it',
  row && !row.url.includes('resources.openrouter.ai'), row && row.url);
check('TELECOMMUTE is read as Remote', row && /^Remote/.test(row.work_type), row && row.work_type);
check('and the location gate accepts it', row && locationEligible(row.work_type, row.title).ok === true);
check('datePosted parses to an ISO instant', row && !Number.isNaN(Date.parse(row.posted)), row && row.posted);
check('the published band is carried', row && row.salary_min === 190000 && row.salary_max === 240000,
  row && `${row.salary_min}-${row.salary_max}`);

/* A Europe-only restriction must reach the gate and be refused there. */
const EU = PAGE.replace('US (CA, CO, FL +14 more)', 'Germany');
const euRow = parsePosting(EU);
check('a Germany sidebar is carried and the gate refuses it',
  euRow && /Germany/.test(euRow.work_type) && locationEligible(euRow.work_type, euRow.title).ok === false,
  euRow && euRow.work_type);

/* Missing pieces yield null rather than a half row. */
check('a page with no JobPosting block yields null',
  parsePosting('<html><a href="https://jobs.ashbyhq.com/x/1">Apply</a></html>') === null);
check('a page with no data-apply-button anchor yields null, even with other outbound links',
  parsePosting(PAGE.replace(/<a href="https:\/\/jobs\.ashbyhq[^>]+>Apply<\/a>/, '')) === null);
check('an unparsable ld+json block is skipped, not fatal',
  parsePosting('<script type="application/ld+json">{nope</script>' + PAGE) !== null);
check('no band yields nulls, never zeros',
  (() => { const r = parsePosting(PAGE.replace(/"baseSalary":\{[^}]*\{[^}]*\}\}/, '"x":1')); return r && r.salary_min === null && r.salary_max === null; })());

console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe sitemap indexes, the JSON-LD records, and the url that comes out is the employer\'s without tracking');
process.exitCode = bad ? 1 : 0;
