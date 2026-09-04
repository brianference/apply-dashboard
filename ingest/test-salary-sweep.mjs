/**
 * The salary sweep's write loop, which FEATURES.md recorded as having no test.
 *
 * The extractor and the floor cases were already covered. This is the loop that
 * decides whether a measurement is actually SAVED, and it is the part that has
 * already gone wrong once in the worst possible way.
 *
 * It used to let the first rejected UPDATE escape, which abandoned every
 * remaining write. Nine rows held match_pct = '' instead of NULL, and SQLite
 * compares text as greater than any integer, so '' > 100 is TRUE and a range
 * trigger rejected any update to those rows. The sweep reported "205 bands
 * found", wrote seven, and exited zero -- the number it printed was what it had
 * MEASURED, and nothing connected that to what it had saved.
 *
 * So the cases here are mostly about what happens when writes FAIL, because a
 * loop that only ever gets successful answers proves nothing about the bug it
 * was written to fix.
 *
 *   node ingest/test-salary-sweep.mjs
 */

import { applyWrites, bandWrite, checkedWrite, belowFloorWrite, d1Changes, FLOOR } from './salary-sweep.mjs';

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

const CHECKED_AT = '2026-09-04T00:00:00.000Z';

/**
 * A stand-in for D1 that records statements and can be told to reject some.
 *
 * @param {(sql: string, params: Array<any>) => ('ok'|'reject'|'nochange')} decide
 */
function fakeRun(decide) {
  const calls = [];
  const run = async (sql, params) => {
    calls.push({ sql, params });
    const verdict = decide(sql, params);
    if (verdict === 'reject') throw new Error('range trigger rejected the update');
    return { result: [{ meta: { changes: verdict === 'nochange' ? 0 : 1 } }] };
  };
  return { run, calls };
}

/* Three results: one with a band, one read successfully with no band, one
   below the floor. */
const RESULTS = [
  { dedupe_key: 'priced', band: { min: 200000, max: 260000 }, via: 'board-api', verdict: 'ok', status: 'queued' },
  { dedupe_key: 'silent', band: { min: null, max: null }, via: 'board-api', verdict: 'unknown', status: 'queued' },
  { dedupe_key: 'low', band: { min: 135000, max: 155000 }, via: 'board-api', verdict: 'below-floor', status: 'queued' }
];

/* ---------------------------------------------------------- the happy path -- */

const happy = fakeRun(() => 'ok');
const out = await applyWrites(RESULTS, { run: happy.run, checkedAt: CHECKED_AT });
/* TWO bands: the below-floor row publishes one too. Knowing what a posting
   pays and deciding it is too low are separate facts, and the band is recorded
   either way. This assertion first said 1, which was my arithmetic being wrong
   rather than the loop. */
check('every row publishing a band gets it written, including the one ruled out',
  out.wroteBands === 2, `bands=${out.wroteBands}`);
/* A successful fetch that published nothing is still a CHECK. Leaving
   salary_checked_at null made "crawled, publishes nothing" indistinguishable
   from "never crawled". */
check('a successful read with no band is still stamped as checked',
  out.wroteChecked === 3, `checked=${out.wroteChecked} (two priced rows plus the silent one)`);
check('a below-floor row is ruled out',
  out.ruledOut === 1, `ruledOut=${out.ruledOut}`);
check('nothing failed and nothing was silently unchanged',
  out.writeFailures.length === 0 && out.writeUnchanged.length === 0);
check('a band row is priced AND ruled out when it is below the floor, in two statements',
  happy.calls.length === 4, `${happy.calls.length} statements`);
check('no band is invented for the silent row',
  !happy.calls.some((c) => /salary_min/.test(c.sql) && c.params.includes('silent')));

/* ------------------------------------------ the failure it was written for -- */

/* One row rejects. Every other row must still be written. */
const partial = fakeRun((_sql, params) => (params.includes('priced') ? 'reject' : 'ok'));
const afterReject = await applyWrites(RESULTS, { run: partial.run, checkedAt: CHECKED_AT });
check('a rejected UPDATE does not abandon the rest of the loop',
  afterReject.ruledOut === 1 && afterReject.wroteChecked === 2 && afterReject.wroteBands === 1,
  `bands=${afterReject.wroteBands} checked=${afterReject.wroteChecked} ruledOut=${afterReject.ruledOut}`);
check('and the rejection is collected rather than thrown',
  afterReject.writeFailures.length === 1
  && afterReject.writeFailures[0].dedupe_key === 'priced',
  JSON.stringify(afterReject.writeFailures[0]));
/* One band written, and it is the OTHER row. The rejected one must not be
   counted, which is the whole difference between measured and saved. */
check('the rejected row is not among the rows counted as written',
  afterReject.wroteBands === 1 && afterReject.writeFailures[0].dedupe_key === 'priced',
  `bands=${afterReject.wroteBands}, failure on ${afterReject.writeFailures[0].dedupe_key}`);
/* It was still ATTEMPTED. A loop that skipped the row entirely would also
   report one band, so the attempt is what separates the fix from the bug. */
check('and it was attempted rather than skipped',
  partial.calls.some((c) => /salary_min/.test(c.sql) && c.params.includes('priced')),
  `${partial.calls.length} statements attempted`);

/* The other half of the same bug: an UPDATE that succeeds but changes nothing
   is not a write, and counting it as one is how "measured" and "saved" drifted
   apart in the first place. */
const nochange = fakeRun(() => 'nochange');
const afterNoChange = await applyWrites(RESULTS, { run: nochange.run, checkedAt: CHECKED_AT });
check('an UPDATE that changed no rows is not counted as a write',
  afterNoChange.wroteBands === 0 && afterNoChange.wroteChecked === 0 && afterNoChange.ruledOut === 0,
  `bands=${afterNoChange.wroteBands} checked=${afterNoChange.wroteChecked}`);
check('and it is reported as unchanged so the run can be loud about it',
  afterNoChange.writeUnchanged.length === 4, `${afterNoChange.writeUnchanged.length} unchanged`);

check('d1Changes reads the row count rather than assuming success',
  d1Changes({ result: [{ meta: { changes: 3 } }] }) === 3
  && d1Changes({}) === 0 && d1Changes(null) === 0);

/* ------------------------------------------------------------ submitted -- */

/* A submitted row is history. Marking it off-criteria now would rewrite what
   happened, so the rule-out must skip it -- while the BAND is still recorded,
   because knowing what it paid is not the same as changing its status. */
const submitted = fakeRun(() => 'ok');
const subOut = await applyWrites(
  [{ dedupe_key: 'gone', band: { min: 135000, max: 155000 }, via: 'board-api', verdict: 'below-floor', status: 'submitted' }],
  { run: submitted.run, checkedAt: CHECKED_AT });
check('a submitted row below the floor is not ruled out',
  subOut.ruledOut === 0, `ruledOut=${subOut.ruledOut}`);
check('but its band is still recorded',
  subOut.wroteBands === 1 && submitted.calls.some((c) => /salary_min/.test(c.sql)));
check('and no statement sets its status',
  !submitted.calls.some((c) => /SET[\s\S]*?\bstatus\b/.test(c.sql)),
  submitted.calls.map((c) => c.sql.slice(0, 40)).join(' | '));

/* ----------------------------------------------------- the statements -- */

const band = bandWrite(RESULTS[0], CHECKED_AT);
check('the band statement is parameterised',
  !/\$?\d{5,}/.test(band.sql) && band.params.includes(200000), band.sql.slice(0, 60));
/* pay_tier is only recomputed for a row that has a rank. Setting it on an
   unranked row would give it a lane it never earned. */
check('pay_tier is only touched when the row has a rank',
  /rank_pct IS NOT NULL/.test(band.sql));

const ruled = belowFloorWrite({ band: { min: 135000 }, dedupe_key: 'low' });
check('ruling out clears rank_pct and pay_tier rather than leaving the old numbers',
  /rank_pct = NULL/.test(ruled.sql) && /pay_tier = NULL/.test(ruled.sql));
check('and says which band failed and against what floor',
  ruled.params.some((p) => String(p).includes('135000') && String(p).includes(String(FLOOR))),
  ruled.params[1]);

const stamped = checkedWrite({ dedupe_key: 'silent' }, CHECKED_AT);
check('the checked stamp touches only salary_checked_at',
  /^UPDATE jobs SET salary_checked_at = \? WHERE/.test(stamped.sql), stamped.sql);

console.log(bad
  ? `\n${bad} FAILED`
  : '\nevery row is attempted, a rejection is collected not thrown, and an update that changed nothing is not a write');
process.exitCode = bad ? 1 : 0;
