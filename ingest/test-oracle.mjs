/**
 * Oracle Recruiting Cloud: the list shape, the closed signal, and the pay band.
 *
 * Three things about this ATS are unlike every other source already wired in,
 * and each one silently loses data if it is got wrong:
 *
 *   A pulled requisition answers 200 with an EMPTY items array. Nothing 404s.
 *   Only a status check would leave every closed Amex row queued forever.
 *
 *   The published pay band is not in the description. It sits in a requisition
 *   flex field, so a prose scan over the JD returns nothing and the band is
 *   lost -- against a standing rule that published salary is never lost.
 *
 *   That band is written WITHOUT separators ("$144250 - $256250"), which the
 *   shared salary parser used to refuse.
 *
 * Fixtures are trimmed from real responses captured on 2026-09-03.
 *
 *   node ingest/test-oracle.mjs
 */

import {
  normalizeOracleJobs,
  requisitionListUrl,
  requisitionsFrom,
  jobUrl
} from './sources/oracle.mjs';
import { oracleDetailUrl, salaryFromOracleFlexFields, oracleDescriptionHtml, readJd } from './jd-read.mjs';
/* Side effect: fit-score calls bindFit(). readJd throws without it. */
import './fit-score.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { salaryFromText } from './salary-from-posting.mjs';
import { filterJobs } from './jobs.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(74)} ${detail || ''}`);
}

const BOARD = { companyName: 'American Express', host: 'egug.fa.us2.oraclecloud.com', site: 'CX_1' };

/* --------------------------------------------------------------- the list -- */

const LIST = {
  items: [{
    TotalJobsCount: 313,
    requisitionList: [
      {
        Id: '26001739',
        Title: 'Manager-Digital Product Management',
        PostedDate: '2026-09-03',
        PrimaryLocation: 'Phoenix, AZ, United States',
        WorkplaceTypeCode: 'ORA_HYBRID'
      },
      {
        Id: '26013141',
        Title: 'Director, Product Development - Agentic Commerce',
        PostedDate: '2026-09-03',
        PrimaryLocation: 'New York, NY, United States',
        WorkplaceTypeCode: ''
      },
      {
        Id: '26013426',
        Title: 'Financial Systems Analyst I',
        PostedDate: '2026-09-03',
        PrimaryLocation: 'Gurugram, HR, India',
        WorkplaceTypeCode: 'ORA_HYBRID'
      }
    ]
  }]
};

const rows = normalizeOracleJobs(LIST, BOARD);
check('the requisition list is read from inside the search-state object',
  rows.length === 3, `rows=${rows.length}`);
check('total is carried alongside the list',
  requisitionsFrom(LIST).total === 313, String(requisitionsFrom(LIST).total));
check('a payload with no items yields no rows rather than throwing',
  normalizeOracleJobs({ items: [] }, BOARD).length === 0);
check('a shape-shifted payload yields no rows rather than throwing',
  normalizeOracleJobs(null, BOARD).length === 0);

const phoenix = rows[0];
check('company is the configured tenant name, not a code',
  phoenix.company === 'American Express', phoenix.company);
check('url is the public candidate-experience posting, not the REST finder',
  phoenix.url === 'https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26001739',
  phoenix.url);
check('posted is the ISO of the published date',
  phoenix.posted === '2026-09-03T00:00:00.000Z', String(phoenix.posted));
/* Oracle publishes one date. A guessed refresh would make every requisition
   look permanently fresh to the stale lens, which is the failure the
   refreshed_at field exists to avoid. */
check('refreshed_at stays null because Oracle reports no refresh',
  phoenix.refreshed_at === null, String(phoenix.refreshed_at));

/* ORA_HYBRID in a column a person reads is not a location. */
check('workplace code is turned into a label a person can read',
  phoenix.work_type === 'Hybrid / Phoenix, AZ, United States', String(phoenix.work_type));
check('a blank workplace code leaves the location alone rather than emitting a stray separator',
  rows[1].work_type === 'New York, NY, United States', String(rows[1].work_type));

/* Oracle's keyword search is a loose OR: asking for "product manager" returns
   a Financial Systems Analyst. The shared query filter is what removes it. */
const filtered = filterJobs(rows, { query: 'product manager' });
check('the shared query filter drops what Oracle loosely matched',
  filtered.length === 1 && filtered[0].title === 'Manager-Digital Product Management',
  filtered.map((r) => r.title).join(' | '));

const idless = normalizeOracleJobs({ items: [{ requisitionList: [{ Title: 'No id' }] }] }, BOARD);
check('a requisition with no id produces no url, so filterJobs drops it',
  idless[0].url === '' && filterJobs(idless).length === 0);

/* ------------------------------------------------------------ the finders -- */

const listUrl = requisitionListUrl(BOARD, { query: 'product manager', limit: 50, offset: 100 });
check('the finder keeps its own commas and semicolon unencoded',
  listUrl.includes('finder=findReqs;siteNumber=CX_1,keyword=product%20manager,limit=50,offset=100'),
  listUrl.slice(listUrl.indexOf('finder=')));
check('the list url sorts newest first',
  listUrl.endsWith('sortBy=POSTING_DATES_DESC'));
check('an empty keyword drops the keyword argument rather than sending a blank one',
  !requisitionListUrl(BOARD, {}).includes('keyword='));

const detail = oracleDetailUrl(jobUrl(BOARD, '26013141'));
check('a posting url maps to its detail finder',
  detail != null && detail.id === '26013141' && detail.site === 'CX_1',
  detail && detail.url);
/* The gateway rejects a bare quote in the finder and rejects an encoded
   semicolon, so the two have to be escaped differently in one string. */
check('finder values are quoted with encoded quotes',
  detail.url.includes('Id=%2226013141%22') && detail.url.includes('siteNumber=%22CX_1%22'));
check('a non-Oracle url is not claimed by the Oracle tier',
  oracleDetailUrl('https://boards.greenhouse.io/gitlab/jobs/123') === null);
check('an Oracle host that is not a posting page is not claimed',
  oracleDetailUrl('https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions') === null);
check('garbage in gives null rather than an exception',
  oracleDetailUrl('not a url') === null);

/* ---------------------------------------------------------------- the pay -- */

const DETAIL_ITEM = {
  Title: 'Director, Product Development',
  ExternalDescriptionStr: '<p>Role overview for the Agentic Commerce platform.</p>',
  ExternalResponsibilitiesStr: '<p>Lead product strategy.</p>',
  ExternalQualificationsStr: '<p>10+ years of product management.</p>',
  CorporateDescriptionStr: '<p>At American Express, a 175-year history.</p>',
  requisitionFlexFields: [
    { Prompt: 'Career Area', Value: 'Product' },
    { Prompt: 'Salary Range', Value: '$144250 - $256250 annually + bonus + equity (if applicable) + benefits' }
  ]
};

const DETAIL_ITEM_LONG = {
  ...DETAIL_ITEM,
  ExternalDescriptionStr: '<p>' + 'Lead product strategy for the Agentic Commerce platform. '.repeat(6) + '</p>',
  ExternalPostedStartDate: '2026-09-03T04:54:45+00:00',
  ExternalPostedEndDate: '2026-09-06T04:00:00+00:00'
};

const band = salaryFromOracleFlexFields(DETAIL_ITEM);
check('the published band is read out of the flex field',
  band != null && band.min === 144250 && band.max === 256250, JSON.stringify(band));
check('a description with no band does not invent one',
  salaryFromOracleFlexFields({ requisitionFlexFields: [{ Prompt: 'Career Area', Value: 'Product' }] }) === null);
check('an item with no flex fields at all yields null',
  salaryFromOracleFlexFields({}) === null);

/* This is the case the shared parser used to refuse. Amex writes the band with
   no thousands separator, and requiring a comma or a k dropped it silently. */
const ungrouped = salaryFromText('$144250 - $256250 annually');
check('the shared parser reads an ungrouped band',
  ungrouped.min === 144250 && ungrouped.max === 256250, JSON.stringify(ungrouped));
check('widening it did not break a comma-grouped band',
  salaryFromText('$126,000-$248,000 USD').min === 126000);
check('widening it did not break a k-suffixed band',
  salaryFromText('$180k - $220k').max === 220000);
/* The protections the narrow rule was carrying have to survive the widening. */
check('an ungrouped filter widget ending in 999 is still refused',
  salaryFromText('$75000 - $99999').min === null);
check('an ungrouped pair below the sanity floor is still refused',
  salaryFromText('$45000 - $52000 annually').min === null);
check('a run of digits longer than a salary is not chopped into one',
  salaryFromText('revenue grew from $120000000 to $9').min === null);

const text = oracleDescriptionHtml(DETAIL_ITEM);
check('the description joins every external-facing part',
  text.includes('Agentic Commerce') && text.includes('Lead product strategy') && text.includes('10+ years'),
  `len=${text.length}`);
check('an empty item gives an empty description rather than "undefined"',
  oracleDescriptionHtml(null) === '' && !oracleDescriptionHtml({}).includes('undefined'));

/* ------------------------------------------------------- the closed signal -- */

/* Every other board in this repo answers 404 for a pulled posting. Oracle
   answers 200 with an empty items array, so a tier that only checks the status
   would call a dead requisition "read", find no text, fall through, and leave
   the row queued forever. This is the case that decides whether closed-check
   can ever retire an Amex row. */

const cacheDir = mkdtempSync(join(tmpdir(), 'oracle-jd-'));
const POSTING = 'https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26013141';

/**
 * @param {number} status
 * @param {unknown} body
 */
function stubFetch(status, body) {
  return async () => ({ status, text: async () => JSON.stringify(body) });
}

const gone = await readJd(POSTING, {
  cacheDir, refetch: true, fetch: stubFetch(200, { items: [] })
});
check('a 200 with an EMPTY items array is read as closed, not as unreadable',
  gone.outcome === 'board-404' && gone.closed === true && gone.via === 'oracle-cx',
  `${gone.outcome} closed=${gone.closed} via=${gone.via}`);

const live = await readJd(POSTING, {
  cacheDir, refetch: true, fetch: stubFetch(200, { items: [DETAIL_ITEM_LONG] })
});
check('a live requisition reads its description through the Oracle tier',
  live.outcome === 'read' && live.via === 'oracle-cx' && live.text.length > 100,
  `${live.outcome} via=${live.via} len=${live.text ? live.text.length : 0}`);
check('and carries the flex-field band with its own source label',
  live.salary && live.salary.min === 144250 && live.salarySource === 'oracle:flexfield',
  `${JSON.stringify(live.salary)} src=${live.salarySource}`);
/* A posting-end date is in the future by definition. Clamping it to now, which
   is what the posted-date helper does, turned "open until the 6th" into
   "expired today" on every Oracle and Workday row. */
check('the posting-end date is NOT clamped back to now',
  live.validThrough === '2026-09-06T04:00:00.000Z', String(live.validThrough));

rmSync(cacheDir, { recursive: true, force: true });

console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe list parses, the finders are built right, and the published band survives');
process.exitCode = bad ? 1 : 0;
