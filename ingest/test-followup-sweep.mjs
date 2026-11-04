/**
 * The follow-up / stale sweep: what it flags and, more to the point, what it
 * must not.
 *
 * Run: node ingest/test-followup-sweep.mjs [module-path]
 * (the optional path lets a TEMP COPY of the module be tested, to prove these
 * checks can fail)
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const target = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href
  : new URL('./followup-sweep.mjs', import.meta.url).href;
const { sweep, sweepOptions, countUnreadable } = await import(target);

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(66)} ${detail ?? ''}`);
};

const ASOF = '2026-11-03T12:00:00Z';
const daysAgo = (n) => new Date(Date.parse(ASOF) - n * 86_400_000).toISOString();
const row = (company, submitted_at, extra = {}) => ({ company, title: 'PM', submitted_at, ...extra });
const names = (list) => list.map((e) => e.company).sort().join(',');

{
  const r = sweep([row('a', daysAgo(9)), row('b', daysAgo(10)), row('c', daysAgo(59)), row('d', daysAgo(60))], ASOF);
  check('9 days quiet is not flagged', !names(r.followup).includes('a') && !names(r.stale).includes('a'));
  check('exactly 10 days is a follow-up', names(r.followup).includes('b'));
  check('59 days is still a follow-up, not stale', names(r.followup).includes('c') && !names(r.stale).includes('c'));
  check('exactly 60 days is stale, and only stale', names(r.stale) === 'd' && !names(r.followup).includes('d'));
}
{
  const r = sweep([
    row('replied', daysAgo(30), { outcome: 'interview', outcome_on: daysAgo(20) }),
    row('undated-outcome', daysAgo(30), { outcome: 'interview' }),
    row('open', daysAgo(30))
  ], ASOF);
  check('a row with a recorded outcome is not flagged', names(r.followup) === 'open', names(r.followup));
}
{
  const r = sweep([row('later', daysAgo(30), { outcome: 'interview', outcome_on: daysAgo(-5) })], ASOF);
  check('an outcome dated AFTER asOf does not hide the row at asOf', names(r.followup) === 'later');
}
{
  const garbage = [row('nul', null), row('empty', ''), row('junk', 'not a date'), row('num', 12345), row('obj', {}), null, undefined, {}];
  let r;
  let threw = false;
  try { r = sweep(garbage, ASOF); } catch { threw = true; }
  check('null, garbage and missing dates do not throw', !threw);
  check('null and garbage dates are never flagged stale', !threw && r.stale.length === 0 && r.followup.length === 0);
}
{
  const r = sweep([row('future', daysAgo(-3)), row('tomorrow', daysAgo(-1))], ASOF);
  check('a row submitted in the future is not flagged', r.followup.length === 0 && r.stale.length === 0);
}
{
  check('an unusable asOf flags nothing and does not throw', JSON.stringify(sweep([row('a', daysAgo(90))], 'garbage')) === '{"followup":[],"stale":[]}');
  const r = sweep([row('a', daysAgo(20)), row('b', daysAgo(90))], ASOF, { followupDays: 14, staleDays: 30 });
  check('thresholds are configurable', names(r.followup) === 'a' && names(r.stale) === 'b');
  const e = sweep([row('a', daysAgo(20))], ASOF).followup[0];
  check('an entry carries company, role, submitted_at, daysQuiet', e.company === 'a' && e.role === 'PM' && e.submitted_at === daysAgo(20) && e.daysQuiet === 20);
  const input = [row('a', daysAgo(20))];
  const before = JSON.stringify(input);
  sweep(input, ASOF);
  check('the input rows are not mutated', JSON.stringify(input) === before);
}

/* CLI flags: a typo must be an error, never an empty report that reads as
   "nothing to follow up" (found by independent review, 2026-11-03). */
{
  const NOW = new Date(ASOF);
  const rejects = (args) => { try { sweepOptions(args, NOW); return false; } catch { return true; } };
  check('no flags gives the defaults', JSON.stringify(sweepOptions({}, NOW)) === JSON.stringify({ asOf: NOW, followupDays: 10, staleDays: 60 }));
  check('--followup abc is an error', rejects({ followup: 'abc' }));
  check('--stale abc is an error', rejects({ stale: 'abc' }));
  check('a bare --followup is an error', rejects({ followup: true }));
  check('zero and negative days are errors', rejects({ followup: '0' }) && rejects({ stale: '-5' }));
  check('--followup at or past --stale is an error', rejects({ followup: '100', stale: '5' }) && rejects({ followup: '60' }));
  check('--asof garbage is an error', rejects({ asof: 'garbage' }));
  check('valid flags are accepted', sweepOptions({ followup: '14', stale: '90', asof: '2026-10-01' }, NOW).staleDays === 90);
  check('unreadable submitted_at rows are counted', countUnreadable([row('a', daysAgo(5)), { company: 'b', submitted_at: 'N/A' }, { company: 'c', submitted_at: null }, null]) === 3);
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
