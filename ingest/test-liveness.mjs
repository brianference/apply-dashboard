/**
 * The liveness check closes production rows, so these cases are mostly about
 * when it must NOT: one signal alone, a board refusing to answer, a submitted
 * row, or a measurer that has stopped working.
 *
 * Page shapes are the ones measured 2026-11-03 from real postings.
 *
 * Run: node ingest/test-liveness.mjs [module-path]
 * (the optional path lets a TEMP COPY of the module be tested, to prove these
 * checks can fail)
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const target = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href
  : new URL('./liveness.mjs', import.meta.url).href;
const {
  verdictFromApi, verdictFromPage, decide, rowsToCheck, rowsToRecheck, reopenClosedWrite,
  measurerProblems, CLOSED_HERE
} = await import(target);
const { closedWrite } = await import('./closed-check.mjs');

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(66)} ${detail ?? ''}`);
};

const GH = { ats: 'greenhouse', token: 'axon', id: '7486973003' };
const LEVER = { ats: 'lever', token: 'truv', id: '8e04c5ba-c4be-406d-b8eb-dad5bcd62112' };
const ASHBY = { ats: 'ashby', token: 'deepgram', id: '9762D2A1-3D07-4E65-A0BB-6ED8162CA7D5' };

/* ---- the API signal ---- */
check('greenhouse 200 is live', verdictFromApi(GH, { status: 200 }) === 'live');
check('lever 404 is gone', verdictFromApi(LEVER, { status: 404 }) === 'gone');
for (const status of [403, 429, 500, 503]) {
  check(`API ${status} is unknown, never gone`, verdictFromApi(GH, { status }) === 'unknown' && verdictFromApi(LEVER, { status }) === 'unknown');
}
check('a network error is unknown', verdictFromApi(GH, { error: 'timeout' }) === 'unknown' && verdictFromApi(ASHBY, { error: 'timeout' }) === 'unknown');
check('no response at all is unknown', verdictFromApi(GH, null) === 'unknown');
check('ashby id on the board is live, in any letter case', verdictFromApi(ASHBY, { status: 200, listedIds: new Set([ASHBY.id.toLowerCase()]) }) === 'live');
check('ashby id missing from a real board list is gone', verdictFromApi(ASHBY, { status: 200, listedIds: new Set(['other']) }) === 'gone');
check('ashby 200 with no readable list is unknown, not gone', verdictFromApi(ASHBY, { status: 200, listedIds: null }) === 'unknown');
check('ashby board failing with 500 is unknown, not gone', verdictFromApi(ASHBY, { status: 500, listedIds: null }) === 'unknown');

/* ---- the page signal ---- */
const liveUrl = 'https://job-boards.greenhouse.io/axon/jobs/7486973003';
check('page 404 is gone', verdictFromPage(LEVER, { status: 404, finalUrl: 'https://jobs.lever.co/x', body: '' }) === 'gone');
check('greenhouse redirect to ?error=true at 200 is gone', verdictFromPage(GH, { status: 200, finalUrl: 'https://job-boards.greenhouse.io/ethoslife?error=true', body: 'x'.repeat(5000) }) === 'gone');
check('page carrying the id in its URL is live', verdictFromPage(GH, { status: 200, finalUrl: liveUrl, body: '' }) === 'live');
check('page carrying the id in its body is live', verdictFromPage(ASHBY, { status: 200, finalUrl: 'https://careers.example.com/', body: `{"id":"${ASHBY.id.toLowerCase()}"}` }) === 'live');
check('a bare 200 with no id and no error is unknown, not gone', verdictFromPage(GH, { status: 200, finalUrl: 'https://careers.example.com/', body: 'x'.repeat(5000) }) === 'unknown');
for (const status of [403, 429, 500]) {
  check(`page ${status} is unknown`, verdictFromPage(GH, { status, finalUrl: liveUrl, body: '' }) === 'unknown');
}
check('page network error is unknown', verdictFromPage(GH, { error: 'timeout' }) === 'unknown');

/* ---- two signals ---- */
check('API gone, page gone closes', decide('gone', 'gone') === 'close');
check('API gone, page live keeps the row (Shield AI)', decide('gone', 'live') === 'keep-disagree');
check('API gone, page unknown keeps the row', decide('gone', 'unknown') === 'keep-unknown');
check('API unknown keeps the row', decide('unknown', null) === 'keep-unknown');
check('API live is live', decide('live', null) === 'live');
check('API unknown never closes even if the page says gone', decide('unknown', 'gone') === 'keep-unknown');

/* ---- which rows ---- */
const row = (status, url, extra = {}) => ({ dedupe_key: `${status}|${url}`, company: 'c', title: 't', status, url, ...extra });
const BOARD = 'https://jobs.lever.co/truv/8e04c5ba-c4be-406d-b8eb-dad5bcd62112';
{
  const picked = rowsToCheck([
    row('queued', BOARD), row('submitted', BOARD), row('skipped', BOARD), row('pending-review', BOARD),
    row('queued', 'https://www.linkedin.com/jobs/view/123'), row('queued', 'https://stripe.com/jobs/search?gh_jid=123'),
    null, row('queued', null)
  ]);
  check('only queued rows on an addressable board are checked', picked.length === 1 && picked[0].row.status === 'queued', `picked ${picked.length}`);
}
{
  const write = closedWrite(row('queued', BOARD), 'liveness: gone');
  check('the close statement refuses a submitted row', /status != \?/.test(write.sql) && write.params.at(-1) === 'submitted');
  check('a close is marked so this file can recognise it later', `closed-check: ${'liveness: gone'}`.startsWith(CLOSED_HERE) && write.params[2].startsWith(CLOSED_HERE));
}
{
  const mine = row('skipped', BOARD, { blocked_reason: 'posting-closed', blocked_detail: `${CLOSED_HERE} gone` });
  const picked = rowsToRecheck([
    mine,
    row('skipped', BOARD, { blocked_reason: 'posting-closed', blocked_detail: 'closed-check: HTTP 404' }),
    row('skipped', BOARD, { blocked_reason: 'off-criteria', blocked_detail: `${CLOSED_HERE} x` }),
    row('submitted', BOARD, { blocked_reason: 'posting-closed', blocked_detail: `${CLOSED_HERE} x` }),
    row('queued', BOARD, { blocked_reason: 'posting-closed', blocked_detail: `${CLOSED_HERE} x` })
  ]);
  check('only rows this file closed can come back', picked.length === 1 && picked[0].row === mine, `picked ${picked.length}`);
  const write = reopenClosedWrite(mine);
  check('a reopen targets only a skipped, posting-closed row', /status = \? AND blocked_reason = \?/.test(write.sql) && write.params.slice(-2).join() === 'skipped,posting-closed');
}

/* ---- the measurer's own health ---- */
const healthy = { ats: 'lever', fakeApi: 'gone', fakePage: 'gone', realPage: 'live' };
check('a healthy measurer reports nothing', measurerProblems([healthy]).length === 0);
check('a made-up id reading live on the API is a problem', measurerProblems([{ ...healthy, fakeApi: 'live' }]).length === 1);
check('a made-up id the API cannot answer is a problem', measurerProblems([{ ...healthy, fakeApi: 'unknown' }]).length === 1);
check('a made-up id reading live on the page is a problem', measurerProblems([{ ...healthy, fakePage: 'live' }]).length === 1);
check('a listed posting that does not read live is a problem', measurerProblems([{ ...healthy, realPage: 'gone' }]).length === 1);
check('a board with no live row to test does not fail on that alone', measurerProblems([{ ...healthy, realPage: null }]).length === 0);

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
