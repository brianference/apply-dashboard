/**
 * The two column repairs, and the reasons each one is narrow.
 *
 * Both defects were found by reading the live queue, not by a failing test, so
 * the cases here are written against the values that were actually stored:
 * "Posted 2 Days Ago (startDate 2026-08-20)" in a date column, and Greenhouse
 * beside greenhouse in the source column.
 *
 * The repair has to be narrow in two directions at once. It must fix the 25
 * broken dates without rewriting the 150 date-only values that are already
 * fine, or every run would report changes forever and none of them would mean
 * anything. And it must fold Greenhouse onto greenhouse without touching
 * "Working Nomads", which is not a board module and is spelled the way it was
 * entered.
 *
 *   node ingest/test-repair-fields.mjs
 */

import { dateRepairs, sourceRepairs, repairFields } from './repair-fields.mjs';
import { canonicalSource, isoFromUnknown } from './jobs.mjs';

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

/* --------------------------------------------------------------- the dates -- */

const ROWS = [
  { dedupe_key: 'a', posted: 'Posted 2 Days Ago (startDate 2026-08-20)', refreshed_at: null, source: 'workday' },
  { dedupe_key: 'b', posted: 'Posted 30+ Days Ago (startDate 2026-04-30)', refreshed_at: null, source: 'Workday' },
  { dedupe_key: 'c', posted: '2026-09-03T04:54:45.000Z', refreshed_at: '2026-09-03T04:54:45.000Z', source: 'greenhouse' },
  { dedupe_key: 'd', posted: '2026-08-21', refreshed_at: null, source: 'Greenhouse' },
  { dedupe_key: 'e', posted: 'Ashby published', refreshed_at: null, source: 'Ashby' },
  { dedupe_key: 'f', posted: null, refreshed_at: null, source: 'Working Nomads' },
  { dedupe_key: 'g', posted: '', refreshed_at: '', source: 'LinkedIn' }
];

const dates = dateRepairs(ROWS);
const byKey = new Map(dates.map((r) => [r.dedupe_key + ':' + r.column, r]));

check('a Workday label is repaired to the date hidden inside it',
  byKey.get('a:posted') && byKey.get('a:posted').to === '2026-08-20T00:00:00.000Z',
  byKey.get('a:posted') && byKey.get('a:posted').to);
check('a 30+ days label keeps its real date rather than becoming today',
  byKey.get('b:posted') && byKey.get('b:posted').to === '2026-04-30T00:00:00.000Z',
  byKey.get('b:posted') && byKey.get('b:posted').to);
/* Text with no date in it becomes null. A date column holding a sentence
   sorts as a string and reads as PRESENT to the backfill, which is how these
   rows survived every run that was supposed to fill them. */
check('text with no recoverable date becomes null, not a guess',
  byKey.get('e:posted') && byKey.get('e:posted').to === null,
  JSON.stringify(byKey.get('e:posted') && byKey.get('e:posted').to));

/* The other direction: this must not churn rows that are already correct. */
check('a full ISO value is left alone',
  !byKey.has('c:posted') && !byKey.has('c:refreshed_at'));
check('a date-only value is left alone rather than rewritten to midnight',
  !byKey.has('d:posted'), 'd was not touched');
check('a null date is not a repair',
  !byKey.has('f:posted'));
check('an empty string is not a repair',
  !byKey.has('g:posted') && !byKey.has('g:refreshed_at'));
check('exactly the three broken dates are listed',
  dates.length === 3, `${dates.length} repairs: ${dates.map((r) => r.dedupe_key).join(',')}`);

/* --------------------------------------------------------------- the source -- */

const sources = sourceRepairs(ROWS);
const srcKeys = sources.map((r) => r.dedupe_key).sort().join(',');
check('capitalised board labels fold onto their module id',
  srcKeys === 'b,d,e', srcKeys);
check('and fold to the lowercase module id, not to something new',
  sources.every((r) => ['workday', 'greenhouse', 'ashby'].includes(r.to)),
  sources.map((r) => r.from + '->' + r.to).join(' | '));
/* Not every label is a board. Folding these would rename real sources. */
check('a non-module label keeps the spelling it was entered with',
  canonicalSource('Working Nomads') === 'Working Nomads' && canonicalSource('LinkedIn') === 'LinkedIn');
check('a label already in canonical form is not a repair',
  !sources.some((r) => r.dedupe_key === 'a' || r.dedupe_key === 'c'));

/* ------------------------------------------------------------- end to end -- */

/**
 * A stand-in for D1 that records what it was asked to write.
 *
 * @param {Array<Record<string, any>>} rows
 */
function fakeD1(rows) {
  const writes = [];
  const state = rows.map((r) => ({ ...r }));
  return {
    writes,
    state,
    query: async (sql, params) => {
      if (/^SELECT/i.test(sql)) return { result: [{ results: state }] };
      writes.push({ sql, params });
      const key = params[1];
      const row = state.find((r) => r.dedupe_key === key);
      /* Mirror the guard in the statement itself: a submitted row is not
         rewritten, so the second pass must still see the original value. */
      if (row && row.status !== 'submitted') {
        if (/SET posted/.test(sql)) row.posted = params[0];
        else if (/SET refreshed_at/.test(sql)) row.refreshed_at = params[0];
        else if (/SET source/.test(sql)) row.source = params[0];
      }
      return { result: [{ results: [] }] };
    }
  };
}

const live = fakeD1(ROWS);
const first = await repairFields({ write: true, query: live.query });
check('a write run reports the repairs it made',
  first.dates === 3 && first.sources === 3 && first.wrote === true,
  `dates=${first.dates} sources=${first.sources}`);
check('every write is scoped away from submitted applications',
  live.writes.length > 0 && live.writes.every((w) => /status != 'submitted'/.test(w.sql)),
  `${live.writes.length} statements`);

/* Idempotence is the property that makes this safe to leave in the daily run.
   If a second pass found work, the repair would be fighting itself. */
const second = await repairFields({ write: true, query: live.query });
check('a second pass over the repaired rows finds nothing to do',
  second.dates === 0 && second.sources === 0,
  `dates=${second.dates} sources=${second.sources}`);

const submitted = fakeD1([
  { dedupe_key: 's', posted: 'Posted 2 Days Ago (startDate 2026-08-20)', refreshed_at: null, source: 'Greenhouse', status: 'submitted' }
]);
await repairFields({ write: true, query: submitted.query });
check('a submitted row is left exactly as it was',
  submitted.state[0].posted === 'Posted 2 Days Ago (startDate 2026-08-20)'
  && submitted.state[0].source === 'Greenhouse',
  submitted.state[0].source);

/* The guard that stops this recurring: the same text arriving from a source
   today is nulled or recovered before it ever reaches a date column. */
check('the ingest boundary now recovers the same string a source could send',
  isoFromUnknown('Posted 2 Days Ago (startDate 2026-08-20)') === '2026-08-20T00:00:00.000Z');
check('and refuses one with no date in it',
  isoFromUnknown('Posted 30+ Days Ago') === null);

console.log(bad
  ? `\n${bad} FAILED`
  : '\nbroken values are repaired, correct ones are left alone, and a second pass is a no-op');
process.exitCode = bad ? 1 : 0;
