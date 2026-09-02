/**
 * first-published and last-updated have to stay different fields.
 *
 * Greenhouse used to write `first_published || updated_at` into `posted`,
 * which is how a 103-day-old Pinterest role refreshed yesterday would look
 * either brand new or dead, depending on which value won. Each case below
 * is a board payload chosen to fail one mixing-up of those two.
 *
 *   node ingest/test-board-dates.mjs
 */

import { datesFromGreenhouse, datesFromAshby, datesFromLever, findBoardJob } from './board-dates.mjs';
import { normalizeGreenhouseJobs } from './sources/greenhouse.mjs';
import { normalizeAshbyJobs } from './sources/ashby.mjs';
import { normalizeLeverJobs } from './sources/lever.mjs';
import { filterJobs } from './jobs.mjs';

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

const PINTEREST = {
  first_published: '2026-05-22T12:00:00.000Z',
  updated_at: '2026-09-01T12:00:00.000Z'
};
const ghDates = datesFromGreenhouse(PINTEREST);
check('greenhouse posted is first_published, not updated_at',
  ghDates.posted === '2026-05-22T12:00:00.000Z',
  `posted=${ghDates.posted}`);
check('greenhouse refreshed_at is updated_at',
  ghDates.refreshed_at === '2026-09-01T12:00:00.000Z',
  `refreshed_at=${ghDates.refreshed_at}`);
check('greenhouse does not fall posted back to updated_at when first_published is missing',
  datesFromGreenhouse({ updated_at: '2026-09-01T12:00:00.000Z' }).posted === null);

const ashbyBoth = datesFromAshby({
  publishedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z'
});
check('ashby posted is publishedAt',
  ashbyBoth.posted === '2026-01-01T00:00:00.000Z');
check('ashby refreshed_at is updatedAt when present',
  ashbyBoth.refreshed_at === '2026-08-20T00:00:00.000Z');
check('ashby refreshed_at falls back to publishedAt when updatedAt is missing',
  datesFromAshby({ publishedAt: '2026-01-01T00:00:00.000Z' }).refreshed_at
    === '2026-01-01T00:00:00.000Z');

const leverMs = datesFromLever({
  createdAt: 1617926400000, /* 2021-04-09 */
  updatedAt: 1754006400000
});
check('lever posted is createdAt converted from epoch ms',
  leverMs.posted === '2021-04-09T00:00:00.000Z',
  `posted=${leverMs.posted}`);
check('lever refreshed_at is updatedAt converted from epoch ms',
  leverMs.refreshed_at === '2025-08-01T00:00:00.000Z',
  `refreshed_at=${leverMs.refreshed_at}`);
check('lever with no updatedAt writes nothing for refresh, not createdAt',
  datesFromLever({ createdAt: 1617926400000 }).refreshed_at === null);

check('a source with no refresh field writes null, not a guess',
  datesFromGreenhouse({ first_published: '2026-05-22T12:00:00.000Z' }).refreshed_at === null);

const normalized = normalizeGreenhouseJobs({
  jobs: [{
    title: 'Product Manager II, Content Compliance',
    company_name: 'Pinterest',
    absolute_url: 'https://job-boards.greenhouse.io/pinterest/jobs/1',
    location: { name: 'Remote, United States' },
    first_published: '2026-05-22T12:00:00.000Z',
    updated_at: '2026-09-01T12:00:00.000Z'
  }]
}, { companyName: 'Pinterest' });
check('normalizeGreenhouseJobs keeps posted and refreshed_at as different values',
  normalized[0].posted === '2026-05-22T12:00:00.000Z'
    && normalized[0].refreshed_at === '2026-09-01T12:00:00.000Z');

const ashbyNorm = normalizeAshbyJobs({
  jobs: [{
    title: 'PM',
    jobUrl: 'https://jobs.ashbyhq.com/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    publishedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z'
  }]
}, { companyName: 'X' });
check('normalizeAshbyJobs writes updatedAt onto refreshed_at',
  ashbyNorm[0].refreshed_at === '2026-08-20T00:00:00.000Z'
    && ashbyNorm[0].posted === '2026-01-01T00:00:00.000Z');

const leverNorm = normalizeLeverJobs([{
  text: 'PM',
  hostedUrl: 'https://jobs.lever.co/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  createdAt: 1617926400000,
  updatedAt: 1754006400000
}], { companyName: 'X' });
check('normalizeLeverJobs converts both epoch fields',
  leverNorm[0].posted === '2021-04-09T00:00:00.000Z'
    && leverNorm[0].refreshed_at === '2025-08-01T00:00:00.000Z');

const filtered = filterJobs(normalized);
check('filterJobs passes refreshed_at through instead of dropping it',
  filtered[0].refreshed_at === '2026-09-01T12:00:00.000Z');
check('filterJobs turns an empty refresh into null, not a guess',
  filterJobs([{ ...normalized[0], refreshed_at: '' }])[0].refreshed_at === null);

const found = findBoardJob('greenhouse', {
  jobs: [
    { id: 1, title: 'other' },
    { id: 5239488008, title: 'Sr. AI Product Manager', first_published: '2026-01-01T00:00:00.000Z' }
  ]
}, '5239488008');
check('findBoardJob matches a greenhouse id from the URL, not the source label',
  found != null && found.title === 'Sr. AI Product Manager');
check('findBoardJob misses a different id',
  findBoardJob('greenhouse', { jobs: [{ id: 1 }] }, '5239488008') === null);

console.log(bad
  ? `\n${bad} FAILED`
  : '\nposted stays first-published, refreshed_at stays last-updated, and the two are not mixed');
process.exitCode = bad ? 1 : 0;
