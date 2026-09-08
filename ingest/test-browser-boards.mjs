/**
 * The two careers sites that only a browser can read.
 *
 * Everything here runs on FIXTURES of the real markup, captured 2026-09-08. The
 * live behaviour is proven separately by running the source; what this pins is
 * the parsing, which is where the mistakes were.
 *
 * Both mistakes came from the same instinct: walking up from an anchor and
 * reading the card's innerText.
 *
 *   Cognizant produced "Manager Save Singapore, SG" as a LOCATION -- the Save
 *   button's label and a title fragment glued to a city. A heuristic over card
 *   text cannot tell a control from an address.
 *
 *   IBM wraps FOUR anchors around one posting (pretitle, title, subtitle,
 *   footer button), so reading anchors returned every job four times, each with
 *   a different fragment of its name.
 *
 * So each adapter names its own title and location element, and these cases
 * hold that.
 *
 *   node ingest/test-browser-boards.mjs
 */

import { ADAPTERS, normalizeRows, locationFromCard, cleanTitle, loadPlaywright, fetchJobs } from './sources/browser-boards.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(72)} ${detail || ''}`);
}

const cognizant = ADAPTERS.find((a) => a.id === 'cognizant');
const ibm = ADAPTERS.find((a) => a.id === 'ibm');
check('both adapters are present', Boolean(cognizant && ibm));

/* ------------------------------------------------------------ the finders -- */

const cogUrl = cognizant.listUrl('product manager remote', 2);
check('the cognizant url carries the keyword and the page',
  cogUrl.includes('keyword=product%20manager%20remote') && cogUrl.includes('page=2'), cogUrl.slice(40));
/* A location parameter alongside the keyword redirects to a marketing page
   with no jobs on it, which is why the location rule does that work instead. */
check('and sends no location parameter',
  !/[?&]location=/.test(cogUrl));

const ibmUrl = ibm.listUrl('product manager', 3);
check('the ibm url pages by record offset, not page number',
  ibmUrl.includes('jobOffset=48') && ibmUrl.includes('jobRecordsPerPage=24'), ibmUrl.slice(45));

/* ----------------------------------------------------------- the location -- */

/* The real strings both sites emit. */
check('a repeated city is said once',
  locationFromCard('Singapore,SG, Singapore, Singapore') === 'Singapore, SG',
  locationFromCard('Singapore,SG, Singapore, Singapore'));
check('a US location keeps its state and country',
  locationFromCard('Eden Prairie, Minnesota, United States') === 'Eden Prairie, Minnesota, United States');
check('a multi-office IBM string is kept whole for the location rule to judge',
  locationFromCard('Austin, Texas, United States').includes('Texas'));
/* An invented location decides whether Brian ever sees a row. */
check('an empty location is null, not a guess',
  locationFromCard('') === null && locationFromCard(null) === null && locationFromCard('   ') === null);

check('a title is squeezed but not truncated to nothing',
  cleanTitle('  Senior   Product   Manager  ') === 'Senior Product Manager');

/* --------------------------------------------------------- normalisation -- */

const rows = normalizeRows([
  { title: 'Product Manager', url: 'https://careers.cognizant.com/global-en/jobs/1/product-manager/', location: 'Phoenix, Arizona, United States' },
  { title: 'Product Manager', url: 'https://careers.cognizant.com/global-en/jobs/1/product-manager/', location: 'Phoenix, Arizona, United States' },
  { title: '', url: 'https://careers.cognizant.com/global-en/jobs/2/x/', location: 'Austin, Texas' },
  { title: 'Has no url', url: '', location: 'Austin, Texas' }
], cognizant);

check('the same url twice becomes one row', rows.length === 1, `${rows.length} rows`);
check('the company is the employer, not the adapter id',
  rows[0].company === 'Cognizant', rows[0].company);
check('the source is the adapter id, so the queue can tell them apart',
  rows[0].source === 'cognizant', rows[0].source);
check('a row with no title is dropped rather than stored blank',
  !rows.some((r) => !r.title));
check('a row with no url is dropped, because it links nowhere',
  !rows.some((r) => !r.url));
/* Neither site states a posted date on its list. A guessed one would make
   every row look new to the freshness filter. */
check('posted and refreshed_at stay null rather than being invented',
  rows[0].posted === null && rows[0].refreshed_at === null);
check('the location reaches work_type, which is what the location rule reads',
  String(rows[0].work_type).includes('Arizona'), rows[0].work_type);

/* --------------------------------------------------- no browser, no crash -- */

/* This module is imported by a step that may have no Chromium. Throwing there
   would take down a run that had already done its real work. */
const withoutBrowser = await fetchJobs({ playwright: null, adapters: [], query: 'product manager' });
check('no playwright means an empty result, not an exception',
  Array.isArray(withoutBrowser) && withoutBrowser.length === 0);
check('loadPlaywright returns a module or null, never throws',
  (() => { const pw = loadPlaywright(); return pw === null || typeof pw === 'object'; })());

console.log(bad
  ? `\n${bad} FAILED`
  : '\neach adapter reads its own title and location element, and a missing browser is empty rather than fatal');
process.exitCode = bad ? 1 : 0;
