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
const { sweep } = await import(target);

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

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
