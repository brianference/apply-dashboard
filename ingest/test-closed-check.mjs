/**
 * A closed-posting verdict has to be defensible, and reversible.
 *
 * 27 queued rows carried `posting-closed` while still holding a rank, written
 * by an ad-hoc script that was never committed. One of them reads "HTTP 200 --
 * the posting is gone", which cannot be a fair reading of the same response.
 * That is what these cases exist to stop: a 200 is not evidence of a closed
 * posting, and a board that refuses to answer is not evidence of anything.
 *
 * Run: node ingest/test-closed-check.mjs
 */

import { classifyClosed, closedWrite, reopenWrite, rowsToRecheck, GONE_MARKERS } from './closed-check.mjs';

const failures = [];
function check(what, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${String(what).padEnd(62)} ${detail}`);
  if (!pass) failures.push(what);
}

const PAGE = 'x'.repeat(400);

/* ---- gone, on evidence ---- */
for (const status of [404, 410]) {
  check(`HTTP ${status} is gone`,
    classifyClosed({ status, body: '' }).verdict === 'gone');
}
check('a 200 page that says the job is no longer open is gone',
  classifyClosed({ status: 200, body: PAGE + ' This job is no longer open. ' + PAGE }).verdict === 'gone');

/* ---- NOT gone: the case that prompted this ---- */
check('a bare HTTP 200 is LIVE, not gone',
  classifyClosed({ status: 200, body: PAGE + ' Apply now for this role ' + PAGE }).verdict === 'live',
  classifyClosed({ status: 200, body: PAGE }).why);
check('HTTP 403 is unknown -- the board refused the read, not the posting',
  classifyClosed({ status: 403, body: '' }).verdict === 'unknown');
check('HTTP 429 is unknown',
  classifyClosed({ status: 429, body: '' }).verdict === 'unknown');
check('HTTP 500 is unknown -- the board is broken, not the posting',
  classifyClosed({ status: 500, body: '' }).verdict === 'unknown');
check('a network error is unknown, never gone',
  classifyClosed({ status: null, body: null, error: 'ECONNRESET' }).verdict === 'unknown');
check('a 200 with almost no text is unknown, not live and not gone',
  classifyClosed({ status: 200, body: '<html><body>loading</body></html>' }).verdict === 'unknown');

/* Every marker must actually fire, or the list is decoration. */
for (const marker of GONE_MARKERS) {
  check(`the marker "${marker}" is recognised`,
    classifyClosed({ status: 200, body: PAGE + ' ' + marker.toUpperCase() + ' ' + PAGE }).verdict === 'gone');
}

/* ---- the writes ---- */
const row = { dedupe_key: 'acme|pm', company: 'Acme', title: 'PM', status: 'queued' };
const gone = closedWrite(row, 'HTTP 404');
check('the closed write skips the row and clears its score',
  /status = \?/.test(gone.sql) && /rank_pct = NULL/.test(gone.sql) && /pay_tier = NULL/.test(gone.sql),
  gone.params[0]);
check('the closed write refuses a submitted row in the WHERE',
  /status != \?/.test(gone.sql) && gone.params.includes('submitted'));

const back = reopenWrite(row, 'HTTP 200 and no closed-posting wording');
check('the reopen write clears blocked_reason so the row returns to the list',
  /blocked_reason = NULL/.test(back.sql), back.params[0]);
check('the reopen write also refuses a submitted row',
  /status != \?/.test(back.sql) && back.params.includes('submitted'));
check('the reopen write does NOT clear the score',
  !/rank_pct = NULL/.test(back.sql));

/* ---- which rows are in scope ---- */
const rows = [
  { dedupe_key: 'a', blocked_reason: 'posting-closed', status: 'queued' },
  { dedupe_key: 'b', blocked_reason: 'posting-closed', status: 'submitted' },
  { dedupe_key: 'c', blocked_reason: 'off-criteria', status: 'queued' },
  { dedupe_key: 'd', blocked_reason: 'posting-closed', status: 'skipped' }
];
const scoped = rowsToRecheck(rows);
check('a submitted row is never re-checked -- it is history',
  !scoped.some((r) => r.dedupe_key === 'b'), scoped.map((r) => r.dedupe_key).join(','));
check('a differently-blocked row is out of scope',
  !scoped.some((r) => r.dedupe_key === 'c'));
check('an already-skipped closed row IS re-checked, so a revived posting comes back',
  scoped.some((r) => r.dedupe_key === 'd'));

console.log(failures.length
  ? `\n${failures.length} FAILED`
  : '\na 200 is not a closed posting, and a refused read is not evidence');
process.exit(failures.length ? 1 : 0);
