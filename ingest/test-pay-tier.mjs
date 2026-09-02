/**
 * Pay is the primary sort key, not a score component.
 *
 * Each case is an input chosen to fail one specific rule. A test that only
 * ever sees the happy path would still pass if payTier always returned 2.
 *
 *   node ingest/test-pay-tier.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { payTier, compareMatchSort, scoreOne, rankWrite, blockedEmployer } from './fit-score.mjs';
import {
  boardTextHasBand, fetchSucceeded, bandWrite, belowFloorWrite,
  checkedWrite, d1Changes
} from './salary-sweep.mjs';
import { ensurePayColumns, pragmaColumns, isDuplicateColumnError } from './pay-columns.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(58)} ${detail || ''}`);
}

/* ---- payTier: the start, and only the start ------------------------- */

check('{salary_min:180000} -> 1', payTier({ salary_min: 180000 }) === 1, String(payTier({ salary_min: 180000 })));
check('{salary_min:179999} -> 3', payTier({ salary_min: 179999 }) === 3, String(payTier({ salary_min: 179999 })));
check('{salary_min:160000} -> 3', payTier({ salary_min: 160000 }) === 3, String(payTier({ salary_min: 160000 })));
check('{salary_min:159999} -> null', payTier({ salary_min: 159999 }) === null, String(payTier({ salary_min: 159999 })));
check('{salary_min:null, salary_max:300000} -> 2',
  payTier({ salary_min: null, salary_max: 300000 }) === 2,
  String(payTier({ salary_min: null, salary_max: 300000 })));
check('{} -> 2', payTier({}) === 2, String(payTier({})));
check('{salary_min:""} -> 2', payTier({ salary_min: '' }) === 2, String(payTier({ salary_min: '' })));
check('{salary_min:0} -> 2', payTier({ salary_min: 0 }) === 2, String(payTier({ salary_min: 0 })));

/* Failing inputs: {salary_min:-1} was a published-looking unknown via
   fall-through (and the gate passed); {salary_min:"180,000"} and
   {salary_min:"$180,000"} were unknown because Number() chokes on separators. */
check('{salary_min:-1} -> 2 (unknown, not a published figure)',
  payTier({ salary_min: -1 }) === 2, String(payTier({ salary_min: -1 })));
check('{salary_min:"180,000"} -> 1',
  payTier({ salary_min: '180,000' }) === 1, String(payTier({ salary_min: '180,000' })));
check('{salary_min:"$180,000"} -> 1',
  payTier({ salary_min: '$180,000' }) === 1, String(payTier({ salary_min: '$180,000' })));

/* These fail if someone uses > instead of >=, or ranks on the top. */
check('exactly FLOOR is lane 1, not 3', payTier({ salary_min: 180000 }) !== 3);
check('one dollar under FLOOR is lane 3, not 1', payTier({ salary_min: 179999 }) !== 1);
check('a $300k top with no start is unknown, not confirmed',
  payTier({ salary_min: null, salary_max: 300000 }) !== 1);

/* Failing input: scoreOne({salary_min:165000, salary_max:175000}) used to
   fail the gate because the published top sat under $180k. That band is
   the case the $160-180k lane is named after. */
const band165 = scoreOne(
  { title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 165000, salary_max: 175000, dedupe_key: 'b165' },
  null
);
check('scoreOne({salary_min:165000, salary_max:175000}) is gate.ok and pay_tier 3',
  band165.gate.ok === true && band165.pay_tier === 3,
  `ok=${band165.gate.ok} tier=${band165.pay_tier} reasons=${(band165.gate.reasons || []).join(';')}`);

const floorStartNoMax = scoreOne(
  { title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 160000, dedupe_key: 'fs' },
  null
);
check('scoreOne({salary_min:160000}) passes the gate as lane 3',
  floorStartNoMax.gate.ok === true && floorStartNoMax.pay_tier === 3,
  `ok=${floorStartNoMax.gate.ok} tier=${floorStartNoMax.pay_tier} reasons=${(floorStartNoMax.gate.reasons || []).join('; ')}`);

const maxOnlyUnder = scoreOne(
  { title: 'Senior Product Manager', work_type: 'Remote US', salary_max: 150000, dedupe_key: 'max150' },
  null
);
check('scoreOne({salary_max:150000}) fails the gate (max-only under the floor)',
  maxOnlyUnder.gate.ok === false && maxOnlyUnder.pay_tier === null,
  String((maxOnlyUnder.gate.reasons || []).join('; ')));

/* A band that starts in $160k-$180k AND reaches $180k+ is still lane 3. */
const okBand160 = scoreOne(
  { title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 160000, salary_max: 180000, dedupe_key: 'ok160' },
  null
);
check('scoreOne on $160k-$180k+ is gate.ok and pay_tier 3',
  okBand160.gate.ok === true && okBand160.pay_tier === 3,
  `ok=${okBand160.gate.ok} tier=${okBand160.pay_tier} reasons=${(okBand160.gate.reasons || []).join(';')}`);

/* ---- sort: a confirmed 59 beats an unpriced 83 ---------------------- */

const FIX = [
  { id: 'unpriced-83', pay_tier: 2, rank_pct: 83 },
  { id: 'confirmed-59', pay_tier: 1, rank_pct: 59 }
];
const orderOf = (rows, cmp) => [...rows].sort(cmp).map((r) => r.id);
check('tier-1 at 59 sorts ahead of unpriced 83',
  orderOf(FIX, compareMatchSort)[0] === 'confirmed-59',
  orderOf(FIX, compareMatchSort).join(' > '));

const THREE = [
  { id: 't3', pay_tier: 3, rank_pct: 90 },
  { id: 't2', pay_tier: 2, rank_pct: 50 },
  { id: 't1', pay_tier: 1, rank_pct: 10 }
];
check('order is 1 then 2 then 3, rank is secondary',
  orderOf(THREE, compareMatchSort).join(',') === 't1,t2,t3',
  orderOf(THREE, compareMatchSort).join(' > '));

check('null/absent tier sinks behind a real lane',
  orderOf(
    [{ id: 'n', pay_tier: null, rank_pct: 99 }, { id: 't2', pay_tier: 2, rank_pct: 1 }],
    compareMatchSort
  )[0] === 't2');

/* The retired comparator. If this block starts passing, the suite is
   decorative: it would still be green against the sort this replaced. */
const OLD = (a, b) => {
  const sc = (j) => Number(j.rank_pct != null ? j.rank_pct : j.match_pct) || 0;
  return sc(b) - sc(a);
};
check('the retired rank-only sort FAILS this case',
  orderOf(FIX, OLD)[0] === 'unpriced-83',
  'old order: ' + orderOf(FIX, OLD).join(' > '));

/* ---- a failed gate clears rank and tier ----------------------------- */

const gated = scoreOne(
  { title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 159999, dedupe_key: 'low-band' },
  null
);
check('gate-failing row has rank null', gated.rank === null, String(gated.rank));
check('gate-failing row has pay_tier null', gated.pay_tier === null, String(gated.pay_tier));
check('the gate actually failed (so the nulls are not a default)', gated.gate.ok === false);

const gatedWrite = rankWrite({ ...gated, job: { dedupe_key: 'low-band' } });
check('gate-fail write sets rank_pct NULL', /rank_pct\s*=\s*NULL/.test(gatedWrite.sql));
check('gate-fail write sets pay_tier NULL', /pay_tier\s*=\s*NULL/.test(gatedWrite.sql));
check('gate-fail write does not skip the row', /UPDATE jobs SET/.test(gatedWrite.sql)
  && gatedWrite.params.includes('low-band'));

const locFail = scoreOne(
  { title: 'Senior Product Manager', work_type: 'San Francisco, CA', salary_min: 180000, dedupe_key: 'sf' },
  null
);
check('a location fail still clears pay_tier even at $180k', locFail.pay_tier === null && locFail.rank === null);

const ok180 = scoreOne(
  { title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 180000, dedupe_key: 'ok' },
  null
);
check('a passing $180k row is tier 1 and ranked', ok180.pay_tier === 1 && ok180.rank !== null,
  `tier=${ok180.pay_tier} rank=${ok180.rank}`);
const okWrite = rankWrite({ ...ok180, job: { dedupe_key: 'ok' } });
check('passing write binds pay_tier 1', okWrite.params.includes(1) && /pay_tier\s*=\s*\?/.test(okWrite.sql));
check('passing write does not null rank_pct', !/rank_pct\s*=\s*NULL/.test(okWrite.sql));

const unknown = scoreOne(
  { title: 'Senior Product Manager', work_type: 'Remote US', dedupe_key: 'u' },
  null
);
check('unpublished passing the gate is tier 2, not null', unknown.pay_tier === 2 && unknown.rank !== null);

/* ---- the pipeline's own call shape ---------------------------------
   daily.mjs passed the bare scoreOne() result, which has no job, so every
   rank write threw a TypeError into a catch that only incremented a
   counter. The suite passed because it built the argument by hand. */

const bare = scoreOne({ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 180000, dedupe_key: 'd' }, null);
check('scoreOne alone does not carry the job', bare.job === undefined);
let threw = null;
try { rankWrite(bare); } catch (e) { threw = e.message; }
check('rankWrite without a job fails by name, not TypeError',
  !!threw && threw.indexOf('rankWrite: no job.dedupe_key') === 0, String(threw));
const daily = fs.readFileSync(path.join(ROOT, 'ingest', 'daily.mjs'), 'utf8');
/* Failing input: a third call written as rankWrite(s2) or rankWrite({ job, ...s })
   used to slip past a count of two exact `{ ...s, job }` matches. */
const rankWriteSites = [...daily.matchAll(/rankWrite\(/g)];
const everySitePassesJob = rankWriteSites.length > 0 && rankWriteSites.every((m) => {
  const snippet = daily.slice(m.index, m.index + 40);
  return /^rankWrite\(\{\s*\.\.\.s,\s*job\s*\}\)/.test(snippet);
});
check('every rankWrite( in daily.mjs is followed by { ...s, job }',
  everySitePassesJob, `sites=${rankWriteSites.length}`);

/* ---- the schema migration must not close an import circle ---------
   fit-score reached ensurePayColumns with `await import('./salary-sweep.mjs')`
   from inside its own top-level CLI block. salary-sweep imports fit-score,
   so the await never settled: node printed "Detected unsettled top-level
   await" and exited having written nothing. Every module test passed. */

const fitSrc = fs.readFileSync(path.join(ROOT, 'ingest', 'fit-score.mjs'), 'utf8');
const payCols = fs.readFileSync(path.join(ROOT, 'ingest', 'pay-columns.mjs'), 'utf8');
/* Failing input: a static `import ... from './salary-sweep.mjs'` -- the old
   check only banned `await import(...)`. */
check('fit-score does not import salary-sweep at all',
  !/from\s+['"]\.\/salary-sweep\.mjs['"]/.test(fitSrc)
  && !/import\s*\(\s*['"]\.\/salary-sweep\.mjs['"]/.test(fitSrc));
check('fit-score takes ensurePayColumns from pay-columns',
  /import \{[^}]*ensurePayColumns[^}]*\} from '\.\/pay-columns\.mjs'/.test(fitSrc));
check('pay-columns imports neither module that imports it',
  !/from '\.\/(fit-score|salary-sweep)\.mjs'/.test(payCols));

/* ---- an employer ruled out by name ---------------------------------
   Brian, 2026-08-31: Coinbase caps how many times you may apply and does not
   reply. The block has to live in the committed list, not only in the
   database, or the next ingest puts the postings straight back. */

check('Coinbase is blocked', blockedEmployer('Coinbase') !== null);
check('a suffixed legal name still matches', blockedEmployer('Coinbase Global, Inc.') !== null);
check('matching is case-insensitive', blockedEmployer('coinbase') !== null);
/* Failing input: a substring match on `coin` would block this one. */
check('Bitcoin Base is NOT blocked', blockedEmployer('Bitcoin Base') === null);
check('an unrelated employer is not blocked', blockedEmployer('Affirm') === null);
check('an empty company is not blocked', blockedEmployer('') === null);

const blockedJob = { company: 'Coinbase', title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 200000, dedupe_key: 'cb' };
const blockedScore = scoreOne(blockedJob, null);
check('a blocked employer fails the gate even at $200k', blockedScore.gate.ok === false);
check('the reason names the employer and why',
  blockedScore.gate.reasons.some((r) => /^employer: Coinbase is blocked/.test(r)),
  blockedScore.gate.reasons.join('; '));
check('a blocked employer carries no rank and no lane',
  blockedScore.rank === null && blockedScore.pay_tier === null);
/* The SAME row with a company nothing blocks must pass, or the check above
   would also pass on a gate that rejects everything. */
const unblocked = scoreOne({ ...blockedJob, company: 'Affirm' }, null);
check('the identical row at an unblocked employer passes',
  unblocked.gate.ok === true && unblocked.pay_tier === 1,
  `ok=${unblocked.gate.ok} tier=${unblocked.pay_tier}`);

/* ---- the $160-180k lane is reachable -------------------------------
   Reproduced 2026-08-31 before the change: a published $165k-$175k band
   failed the gate on `publishes $175k, under the $180k floor`, so the lane
   could only ever hold ranges that ALSO reached $180k+. */

const secondLane = scoreOne({ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 165000, salary_max: 175000, dedupe_key: 's' }, null);
check('a published $165k-$175k band is lane 3, not a reject',
  secondLane.gate.ok === true && secondLane.pay_tier === 3,
  `ok=${secondLane.gate.ok} tier=${secondLane.pay_tier}`);
const noMax = scoreOne({ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 160000, dedupe_key: 'n' }, null);
check('a $160k start with no max is lane 3', noMax.gate.ok === true && noMax.pay_tier === 3);
const maxOnlyLow = scoreOne({ title: 'Senior Product Manager', work_type: 'Remote US', salary_max: 150000, dedupe_key: 'm' }, null);
check('a max-only $150k is still a reject, not unknown', maxOnlyLow.gate.ok === false);
const stillLow = scoreOne({ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 159999, dedupe_key: 'l' }, null);
check('a $159,999 start still fails', stillLow.gate.ok === false && stillLow.pay_tier === null);

/* ---- unpriced is provable; board text without a band is not enough -- */

check('board-api is a successful check', fetchSucceeded('board-api') === true);
check('page with no band is a successful check', fetchSucceeded('page') === true);
check('page-404 is not a successful check', fetchSucceeded('page-404') === false);
check('page-403 is not a successful check', fetchSucceeded('page-403') === false);
check('page-401 is not a successful check', fetchSucceeded('page-401') === false);
check('page-405 is not a successful check', fetchSucceeded('page-405') === false);
check('page-410 is not a successful check', fetchSucceeded('page-410') === false);
check('page-500 is not a successful check', fetchSucceeded('page-500') === false);
check('page-503 is not a successful check', fetchSucceeded('page-503') === false);
check('page-error is not a successful check', fetchSucceeded('page-error') === false);
/* Failing inputs the denylist never named, so the old suite could not fail. */
check('page-502 is not a successful check', fetchSucceeded('page-502') === false);
check('page-429 is not a successful check', fetchSucceeded('page-429') === false);
check('page-400 is not a successful check', fetchSucceeded('page-400') === false);
check('page-408 is not a successful check', fetchSucceeded('page-408') === false);
check('empty via is not a successful check', fetchSucceeded('') === false);

const pad = (s) => ('About the role. '.repeat(20)) + s;
check('board text with a range is a band',
  boardTextHasBand(pad('Base salary: $180,000-$220,000 annually.')) === true);
check('board text without a range is not a band',
  boardTextHasBand(pad('Great benefits and a competitive package.')) === false);
check('a short board body is not enough even with a range',
  boardTextHasBand('Base salary: $180,000-$220,000 annually.') === false);
check('empty board text is not a band', boardTextHasBand('') === false);
check('null board text is not a band', boardTextHasBand(null) === false);

/* ---- the page actually sorts by tier, and names the groups ---------- */

const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const matchBlock = page.match(/if \(sortBy === "match"\) \{[\s\S]*?\} else if \(sortBy === "company"\)/);
check('page match-sort block is present', !!matchBlock);
const block = matchBlock ? matchBlock[0] : '';
const tierCmp = block.search(/tier\s*\(\s*x\s*\)\s*-\s*tier\s*\(\s*y\s*\)/);
const scoreCmp = block.search(/sc\s*\(\s*y\s*\)\s*-\s*sc\s*\(\s*x\s*\)/);
/* Failing input: a rank-first comparator that still mentions pay_tier in a
   comment. The tier comparison must appear BEFORE the score comparison. */
check('page match sort compares pay_tier before rank',
  tierCmp !== -1 && scoreCmp !== -1 && tierCmp < scoreCmp,
  `tier@${tierCmp} score@${scoreCmp}`);
const norm = (s) => s.replace(/\s+/g, ' ');
check('page match sort is not the retired rank-only line',
  !/c\.sort\(function \(x, y\) \{ return sc\(y\) - sc\(x\); \}\)/.test(norm(block)));

/* Source check is the best available here: this suite does not render the
   page. Assert the labels object rowsWithTiers actually builds, not a
   comment that happens to mention the string. */
const labelsAssign = page.match(/var labels = \{[\s\S]*?\};/);
check('rowsWithTiers labels include Confirmed $180k+',
  !!(labelsAssign && /Confirmed \$180k\+/.test(labelsAssign[0])));
check('rowsWithTiers labels include Pay not published',
  !!(labelsAssign && /Pay not published/.test(labelsAssign[0])));
check('rowsWithTiers labels include Confirmed $160-180k',
  !!(labelsAssign && /Confirmed \$160-180k/.test(labelsAssign[0])));
check('rowsWithTiers labels include Not yet ranked',
  !!(labelsAssign && /Not yet ranked/.test(labelsAssign[0])));
check('un-tiered key is used when pay_tier is not 1/2/3',
  !!(labelsAssign && /: "none"/.test(page.match(/var key = [\s\S]{0,120}/) && page.match(/var key = [\s\S]{0,120}/)[0] || '')));
check('lane dividers use sechead-divider and the class is defined',
  /class="sechead sechead-divider"/.test(page)
  && /\.sechead-divider\s*\{[^}]*cursor:\s*default/.test(page));

const sweep = fs.readFileSync(path.join(ROOT, 'ingest', 'salary-sweep.mjs'), 'utf8');
check('postingText consults the band before returning board text',
  /boardTextHasBand\(boardText\)/.test(sweep));
/* Behavioural: checkedWrite is what stamps the column; fetchSucceeded is
   the guard. A comment mentioning salary_checked_at is not enough. */
const stamped = checkedWrite({ dedupe_key: 'k' }, 'ts');
check('checkedWrite stamps salary_checked_at',
  /salary_checked_at\s*=\s*\?/.test(stamped.sql) && stamped.params[0] === 'ts' && stamped.params[1] === 'k');
check('salary-sweep stamps checked_at only after fetchSucceeded',
  /else if \(fetchSucceeded\(r\.via\)\)/.test(sweep) && /checkedWrite\(r, checkedAt\)/.test(sweep));

/* ---- sweep writes: lane from the new band, below-floor clears rank -- */

/* Failing input: a ranked row whose sweep finds $190,000-$220,000 used to
   write the band and leave pay_tier = 2. */
const bw = bandWrite({ band: { min: 190000, max: 220000 }, via: 'page', dedupe_key: 'k' }, 'ts');
check('bandWrite binds pay_tier 1 for a $190k start',
  bw.params.includes(1) && /pay_tier/.test(bw.sql), String(bw.params));
check('bandWrite only overwrites pay_tier when rank_pct is set',
  /CASE WHEN rank_pct IS NOT NULL/.test(norm(bw.sql)));
const bwUnrankedLane = bandWrite({ band: { min: 165000, max: 200000 }, via: 'page', dedupe_key: 'k' }, 'ts');
check('bandWrite binds pay_tier 3 for a $165k start',
  bwUnrankedLane.params.includes(3), String(bwUnrankedLane.params));

/* Failing input: a ranked row whose sweep finds $135,000-$155,000 used to
   set blocked_reason only and leave rank_pct and pay_tier sitting. */
const bf = belowFloorWrite({ band: { min: 135000 }, dedupe_key: 'k' });
check('belowFloorWrite sets status skipped',
  /status\s*=\s*\?/.test(bf.sql) && bf.params.includes('skipped'));
check('belowFloorWrite clears rank_pct', /rank_pct\s*=\s*NULL/.test(bf.sql));
check('belowFloorWrite clears pay_tier', /pay_tier\s*=\s*NULL/.test(bf.sql));
check('below-floor write is skipped for submitted rows',
  /verdict === 'below-floor' && r\.status !== 'submitted'/.test(sweep));

/* Source check is the best available: running --write hits the live jobs
   API before it looks at the token. */
check('--write with no token process.exit(1)s',
  /if\s*\(\s*!token\s*\)\s*\{[\s\S]{0,160}process\.exit\(1\)/.test(sweep));

/* Failing input: an UPDATE against a missing dedupe_key returns success
   with meta.changes = 0 and must not increment wroteBands. */
check('d1Changes reads REST envelope changes=0',
  d1Changes({ success: true, result: [{ results: [], meta: { changes: 0 } }] }) === 0);
check('d1Changes reads REST envelope changes=1',
  d1Changes({ success: true, result: [{ results: [], meta: { changes: 1 } }] }) === 1);
check('d1Changes reads Workers .all() shape',
  d1Changes({ results: [], success: true, meta: { changes: 1 } }) === 1);
check('sweep counts d1Changes, not assumed success',
  /d1Changes\(res\)/.test(sweep));

/* ---- ensurePayColumns: Workers shape and duplicate-column ----------- */

/* Failing input: { results, success, meta } used to yield cols = []. */
check('pragmaColumns reads a raw array',
  pragmaColumns([{ name: 'pay_tier' }]).map((c) => c.name).join(',') === 'pay_tier');
check('pragmaColumns reads D1 REST envelope',
  pragmaColumns({ result: [{ results: [{ name: 'pay_tier' }] }] }).map((c) => c.name).join(',') === 'pay_tier');
check('pragmaColumns reads Workers .all() shape',
  pragmaColumns({ results: [{ name: 'pay_tier' }], success: true, meta: {} }).map((c) => c.name).join(',') === 'pay_tier');

check('duplicate column name: pay_tier is swallowed',
  isDuplicateColumnError(new Error('duplicate column name: pay_tier'), 'pay_tier') === true);
check('no such table: jobs is not a duplicate-column error',
  isDuplicateColumnError(new Error('no such table: jobs'), 'pay_tier') === false);

let workersAlters = 0;
await ensurePayColumns(async (sql) => {
  if (String(sql).startsWith('PRAGMA')) {
    return {
      results: [{ name: 'pay_tier' }, { name: 'salary_checked_at' }, { name: 'refreshed_at' }],
      success: true,
      meta: {}
    };
  }
  workersAlters += 1;
  throw new Error('duplicate column name: pay_tier');
});
check('Workers .all() with columns present does not ALTER', workersAlters === 0);

let dupAlters = 0;
await ensurePayColumns(async (sql) => {
  if (String(sql).startsWith('PRAGMA')) return { results: [], success: true, meta: {} };
  dupAlters += 1;
  const col = /ADD COLUMN (\w+)/.exec(String(sql));
  throw new Error('duplicate column name: ' + (col ? col[1] : 'unknown'));
});
check('unreadable pragma still tolerates duplicate-column ALTER', dupAlters === 3);

let otherErr = null;
try {
  await ensurePayColumns(async (sql) => {
    if (String(sql).startsWith('PRAGMA')) return [];
    throw new Error('no such table: jobs');
  });
} catch (error) {
  otherErr = error;
}
check('non-duplicate ALTER error is rethrown',
  !!(otherErr && /no such table: jobs/.test(otherErr.message)));

console.log(bad ? `\n${bad} FAILED` : '\npay-first ranking holds on the cases built to break it');
process.exitCode = bad ? 1 : 0;
