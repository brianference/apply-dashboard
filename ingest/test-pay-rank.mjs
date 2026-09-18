/**
 * Pay in the headline has to be able to FAIL.
 *
 * A suite that only checked "scoreOne returns a number" would still pass if
 * payTerm were always 0, which would quietly punish every posting, or if the
 * weights summed to 0.95, which would silently compress every score. Each
 * case below is an input chosen to fail one specific rule.
 *
 *   node ingest/test-pay-rank.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  payPercentile, publishedStarts, rankBlend, scoreOne, rankWhy,
  FRESH_BONUS, FRESH_DAYS,
  RANK_FIT_WEIGHT, RANK_SUCCESS_WEIGHT, RANK_PAY_WEIGHT, RANK_UNREAD_CEILING, unreadBlend,
  RANK_UNREAD_SUCCESS_WEIGHT
} from './fit-score.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');

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

const JOB = { title: 'Senior Product Manager', work_type: 'Remote US' };

/* A description that names enough concepts for fitScore to return a number
   rather than null, so the three-term blend actually runs. */
const READABLE = `We are hiring a Senior Product Manager for our enterprise SaaS reporting
platform. You will own the roadmap for AI and LLM powered analytics, work cross-functional
with design and engineering, run experimentation with tools like Amplitude, and build
dashboards for business customers. Experience with B2B enterprise customers required.
5+ years of product experience.`.repeat(3);

/* ---- percentile: calibrate()'s shape -------------------------------- */

const twenty = [];
for (let i = 1; i <= 20; i++) twenty.push(i * 10000);

check('a start below every other is 0',
  payPercentile(0, twenty) === 0, String(payPercentile(0, twenty)));

const top = payPercentile(999999, twenty);
check('a start above every other is 100',
  top === 100, String(top));
check('the highest start IN the list is ~100 ((n-1)/n, same as calibrate)',
  payPercentile(200000, twenty) === Math.round(19 / 20 * 100),
  String(payPercentile(200000, twenty)));

const mid = payPercentile(110000, twenty);
check('the middle of a 20-start list is ~50',
  mid >= 45 && mid <= 55, String(mid));

const ties = [100000, 200000, 200000, 200000, 300000];
const tied = payPercentile(200000, ties);
check('a value equal to several others is not double-counted (strictly below)',
  tied === Math.round(1 / 5 * 100), String(tied));
check('counting equals as below would have been 80 -- that is the bug',
  tied !== Math.round(4 / 5 * 100), String(tied));

/* ---- empty or missing is 50, NOT 0 ----------------------------------
   Assert the value. 0 here would quietly punish the whole list. */

check('empty distribution is 50, not 0', payPercentile(240000, []) === 50,
  String(payPercentile(240000, [])));
check('missing distribution is 50, not 0', payPercentile(240000, null) === 50,
  String(payPercentile(240000, null)));
check('undefined distribution is 50, not 0', payPercentile(240000, undefined) === 50,
  String(payPercentile(240000, undefined)));
check('empty distribution is 50 even for a zero start -- never 0 as punishment',
  payPercentile(0, []) === 50, String(payPercentile(0, [])));
check('publishedStarts([]) is empty, not a padded [0]',
  Array.isArray(publishedStarts([])) && publishedStarts([]).length === 0);

const noDist = scoreOne({ ...JOB, salary_min: 400000, dedupe_key: 'nodist' }, READABLE);
check('scoreOne with no distribution gives payTerm 50, not 0, even at $400k',
  noDist.payTerm === 50, String(noDist.payTerm));

/* ---- blend arithmetic on a hand-worked case ------------------------- */

check('fit 80, success 60, pay 90 is round(24 + 36 + 9) = 69',
  rankBlend(80, 60, 90) === 69, String(rankBlend(80, 60, 90)));

check('fit weight is 0.30', RANK_FIT_WEIGHT === 0.30, String(RANK_FIT_WEIGHT));
check('success weight is 0.60', RANK_SUCCESS_WEIGHT === 0.60, String(RANK_SUCCESS_WEIGHT));
check('pay weight is 0.10', RANK_PAY_WEIGHT === 0.10, String(RANK_PAY_WEIGHT));
/* 0.3 + 0.6 + 0.1 is 0.9999999999999999 in binary floating point, so the
   comparison allows for that and still catches a real 0.95. */
check('weights sum to 1.0 -- a future 0.95 would silently compress every score',
  Math.abs(RANK_FIT_WEIGHT + RANK_SUCCESS_WEIGHT + RANK_PAY_WEIGHT - 1) < 1e-9,
  String(RANK_FIT_WEIGHT + RANK_SUCCESS_WEIGHT + RANK_PAY_WEIGHT));
check('unread still weights success at 0.6',
  RANK_UNREAD_SUCCESS_WEIGHT === 0.6, String(RANK_UNREAD_SUCCESS_WEIGHT));

/* ---- unpriced and a median band share payTerm ----------------------- */

const ten = [160000, 170000, 180000, 190000, 200000, 210000, 220000, 230000, 240000, 250000];
/* 210000 has five starts strictly below it: 5/10 * 100 = 50. That is the
   median in calibrate()'s strictly-below sense. */
check('a $210k start in a 10-row priced list is payTerm 50',
  payPercentile(210000, ten) === 50, String(payPercentile(210000, ten)));

const pricedMedian = scoreOne(
  { ...JOB, salary_min: 210000, dedupe_key: 'med' }, READABLE, ten
);
const unpriced = scoreOne(
  { ...JOB, dedupe_key: 'unp' }, READABLE, ten
);
check('an unpriced row and a priced row with a median band get the same payTerm',
  pricedMedian.payTerm === 50 && unpriced.payTerm === 50
    && pricedMedian.payTerm === unpriced.payTerm,
  `priced=${pricedMedian.payTerm} unpriced=${unpriced.payTerm}`);
check('unpriced payStart is null, median-priced payStart is 210000',
  unpriced.payStart === null && pricedMedian.payStart === 210000,
  `unpriced=${unpriced.payStart} priced=${pricedMedian.payStart}`);

/* ---- fit === null counts pay, and stays capped at 60 -----------------

   This branch ignored pay until 2026-09-03, so a posting with a published
   $280k band and no fetchable description scored on success alone. Brian asked
   for it. The fit term is dropped WITHOUT renormalising, so success and pay
   carry 0.35 and 0.25 and the ceiling is 60 -- the same ceiling success * 0.6
   gave before. That matters: a row nobody could read must not outrank one that
   WAS read, because less evidence cannot beat more. */

const unreadHigh = scoreOne(
  { ...JOB, salary_min: 400000, dedupe_key: 'unread' },
  null,
  [160000, 180000, 200000, 400000]
);
check('unread description has fit null', unreadHigh.fit === null);
check('unread rank counts the pay term, through the scaled blend',
  unreadHigh.rank === unreadBlend(unreadHigh.success.pct, unreadHigh.payTerm),
  `rank=${unreadHigh.rank} success=${unreadHigh.success.pct} payTerm=${unreadHigh.payTerm}`);
check('a top-of-list band raises an unread row above success * 0.6',
  unreadHigh.rank > Math.round(unreadHigh.success.pct * RANK_UNREAD_SUCCESS_WEIGHT),
  `${unreadHigh.rank} > ${Math.round(unreadHigh.success.pct * RANK_UNREAD_SUCCESS_WEIGHT)}`);

/* The ceiling, asserted at the extreme rather than assumed. Perfect success and
   the top pay percentile must still land at 60, or an unread row could reach
   the same score as a fully-scored one. */
/* Under success-led weights the raw two-term sum is 0.70. The ceiling is now
   stated and scaled to, so it cannot drift with the weights: an unreadable
   posting must not outrank read ones in the sixties. */
check('the unread ceiling is 60, even at success 100 and pay 100',
  unreadBlend(100, 100) === 60, String(unreadBlend(100, 100)));
check('the unread ceiling equals the old success-only ceiling',
  RANK_UNREAD_CEILING === Math.round(100 * RANK_UNREAD_SUCCESS_WEIGHT),
  `${RANK_UNREAD_CEILING} vs ${Math.round(100 * RANK_UNREAD_SUCCESS_WEIGHT)}`);
check('the raw two-term sum WOULD exceed the ceiling without scaling, which is why it is scaled',
  Math.round(100 * RANK_SUCCESS_WEIGHT + 100 * RANK_PAY_WEIGHT) > RANK_UNREAD_CEILING,
  String(Math.round(100 * RANK_SUCCESS_WEIGHT + 100 * RANK_PAY_WEIGHT)));

/* And an unpriced unread row takes the median, so it is not punished for the
   board publishing nothing. */
const unreadUnpriced = scoreOne({ ...JOB, dedupe_key: 'unread-unpriced' }, null, [160000, 400000]);
check('an unread unpriced row uses the median pay term',
  unreadUnpriced.payTerm === 50, String(unreadUnpriced.payTerm));

/* ---- rank_why names the pay component ------------------------------- */

const whyPriced = rankWhy({
  fit: { pct: 80, resumePct: 54, matched: ['roadmap'], missing: [], hits: [] },
  success: { pct: 60, reasons: [] },
  offFocus: null,
  payTerm: 18,
  payStart: 170000
});
check('rank_why names pay the way resume is named',
  whyPriced.indexOf('pay: starts at $170k, higher than 18% of priced postings') !== -1,
  whyPriced);
check('rank_why still names the resume line',
  whyPriced.indexOf('resume: better than 54% of your queue') !== -1);

const whyUnpriced = rankWhy({
  fit: { pct: 80, resumePct: null, matched: [], missing: [], hits: [] },
  success: { pct: 60, reasons: [] },
  offFocus: null,
  payTerm: 50,
  payStart: null
});
check('rank_why says an unpriced row was treated as the median',
  whyUnpriced.indexOf('pay: no published band, treated as the median of priced postings') !== -1,
  whyUnpriced);

const whyUnread = rankWhy({
  fit: null,
  success: { pct: 70, reasons: [] },
  offFocus: null,
  payTerm: 90,
  payStart: 400000
});
check('rank_why does not claim a pay movement on an unread row',
  whyUnread.indexOf('pay:') === -1, whyUnread);

/* ---- scoreOne actually uses the three-term blend -------------------- */

const wired = scoreOne(
  { ...JOB, salary_min: 240000, dedupe_key: 'wired' }, READABLE, ten
);
check('scoreOne rank equals rankBlend(fit, success, payTerm) when fit is measured',
  wired.fit != null && wired.rank === rankBlend(wired.fit.pct, wired.success.pct, wired.payTerm),
  `rank=${wired.rank} blend=${wired.fit ? rankBlend(wired.fit.pct, wired.success.pct, wired.payTerm) : 'no-fit'} payTerm=${wired.payTerm}`);

/* ---- ORDERING: what pay may and may not do ---------------------------
   On 2026-09-03 the pay term was added so that a high published start could
   reverse a fit-and-success ordering, and the test here asserted exactly that
   reversal. On 2026-09-18 the first three interview outcomes were measured
   against all 150 applications, and the employers that replied were the ones a
   high start had been ranking DOWN: Mitratech's $170k start, Bjak's unpublished
   pay. So the property is now the opposite, and stated: pay still orders two
   otherwise-equal rows, but it no longer overturns a 20-point gap in fit and
   success. docs/ranking-plan.md carries the numbers. */

const lowPay = { fit: 80, success: 80, pay: 10 };
const highPay = { fit: 60, success: 60, pay: 90 };
const newOf = (row) => rankBlend(row.fit, row.success, row.pay);

check('pay still counts: equal fit and success, the higher start ranks higher',
  rankBlend(70, 70, 90) > rankBlend(70, 70, 10),
  `${rankBlend(70, 70, 90)} vs ${rankBlend(70, 70, 10)}`);
check('pay no longer overturns a 20-point fit-and-success gap (the 2026-09-03 reversal is retired)',
  newOf(lowPay) > newOf(highPay),
  `stronger row ${newOf(lowPay)} vs high-pay ${newOf(highPay)}`);

/* Same claim through scoreOne, so a blend function the scorer never calls
   cannot satisfy the suite. Same description, same title, different pay:
   the only difference is the start, so pay must decide. */
const dist = [160000, 170000, 180000, 190000, 200000, 210000, 220000, 230000, 240000, 250000, 260000, 270000, 280000];
const lowPayRow = scoreOne(
  { ...JOB, title: 'Senior Product Manager', salary_min: 160000, dedupe_key: 'low' }, READABLE, dist
);
const highPayRow = scoreOne(
  { ...JOB, title: 'Senior Product Manager', salary_min: 280000, dedupe_key: 'high' }, READABLE, dist
);
check('scoreOne: with everything else equal, the higher start ranks higher',
  highPayRow.rank > lowPayRow.rank,
  `high-pay ${highPayRow.rank} vs low-pay ${lowPayRow.rank} (payTerm ${highPayRow.payTerm} vs ${lowPayRow.payTerm})`);
check('scoreOne: and the gap pay makes is small, under 10 points on a 160k-to-280k spread',
  highPayRow.rank - lowPayRow.rank > 0 && highPayRow.rank - lowPayRow.rank < 10,
  `gap ${highPayRow.rank - lowPayRow.rank}`);

/* ---- known-bad: a temp copy with one weight changed MUST fail -------
   Never in the working tree. If this block starts passing because the copy
   still scores 76, the suite is decorative. */

const src = fs.readFileSync(path.join(ROOT, 'ingest', 'fit-score.mjs'), 'utf8');
check('the source names RANK_PAY_WEIGHT = 0.10 so a temp copy can change it',
  /export const RANK_PAY_WEIGHT = 0\.10/.test(src));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-rank-'));
const ingestUrl = pathToFileURL(path.join(ROOT, 'ingest')).href.replace(/\/$/, '');
const brokenSrc = src
  .replace('export const RANK_PAY_WEIGHT = 0.10', 'export const RANK_PAY_WEIGHT = 0.25')
  .replace(/from '\.\//g, `from '${ingestUrl}/`);
const brokenPath = path.join(tmp, 'fit-score.mjs');
fs.writeFileSync(brokenPath, brokenSrc);
const broken = await import(pathToFileURL(brokenPath).href);

const brokenBlend = broken.rankBlend(80, 60, 90);
const brokenSum = broken.RANK_FIT_WEIGHT + broken.RANK_SUCCESS_WEIGHT + broken.RANK_PAY_WEIGHT;
check('TEMP COPY with pay weight 0.25 FAILS the hand-worked 69',
  brokenBlend !== 69, `got ${brokenBlend}`);
check('TEMP COPY with pay weight 0.25 FAILS the weights-sum-to-1.0 assertion',
  brokenSum !== 1, `sum=${brokenSum}`);
check('the real module still scores that case 69 after the copy was broken',
  rankBlend(80, 60, 90) === 69);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir is a proof, not a product */ }

/* ---- the percentile must not depend on the batch ----------------------
   daily.mjs caps the batch (--max-rank 200) and the fit-score CLI caps it with
   --limit. Both built the distribution from the rows being scored, so the same
   posting could read one percentile on a run of 200 and another on a run of 40
   because the batch around it changed. A score that moves when nothing about
   the job moved is the class of bug this repo keeps finding. The distribution
   comes from every queued row now, and these are what fail if that reverts. */
const population = [
  { salary_min: 150000 }, { salary_min: 160000 }, { salary_min: 170000 },
  { salary_min: 180000 }, { salary_min: 200000 }, { salary_min: 220000 },
  { salary_min: 240000 }, { salary_min: 280000 }, { salary_min: 300000 },
  { salary_min: 400000 }
];
const wholeQueue = publishedStarts(population);
const smallBatch = publishedStarts(population.slice(0, 3));
check('a batch-sized distribution gives a different answer, which is why it is wrong',
  payPercentile(170000, wholeQueue) !== payPercentile(170000, smallBatch),
  `whole ${payPercentile(170000, wholeQueue)} vs batch ${payPercentile(170000, smallBatch)}`);
check('against the whole population $170k is the 20th percentile',
  payPercentile(170000, wholeQueue) === 20,
  String(payPercentile(170000, wholeQueue)));

/* The call sites are asserted against the SOURCE, because using the wrong
   population is a wiring mistake and no unit test of a pure function can see
   it. This is the same reason check-coverage reads FEATURES.md. */
const dailySrc = fs.readFileSync(path.join(ROOT, 'ingest', 'daily.mjs'), 'utf8');
/* The identifier has to be one the file actually declares.

   My first version of this case asserted the STRING
   "publishedStarts(all.filter(" was present, and it was -- while `all` was
   undefined in daily.mjs. CI died with a ReferenceError on a line this test
   had just called correct, and it died in the --dry step, which is the only
   reason it did not reach a scheduled write. A text match cannot see an
   undefined reference, so the name is extracted and checked against the
   file's own declarations. */
const dailyCall = /publishedStarts\((\w+)\.filter\(/.exec(dailySrc);
const dailyName = dailyCall ? dailyCall[1] : null;
check('daily.mjs builds the distribution from a queued filter, not the batch',
  !!dailyName && dailySrc.indexOf('publishedStarts(needsRank') === -1,
  dailySrc.indexOf('publishedStarts(needsRank') !== -1 ? 'STILL USES THE BATCH'
    : (dailyName || 'NO CALL FOUND'));
check('and that identifier is declared in daily.mjs',
  !!dailyName && new RegExp('(?:const|let|var)\\s+' + dailyName + '\\b').test(dailySrc),
  dailyName || '');
check('the queued filter really is on status',
  !!dailyName && new RegExp(dailyName + '\\.filter\\([^)]*status').test(dailySrc),
  dailyName || '');

const fitSrc = fs.readFileSync(path.join(ROOT, 'ingest', 'fit-score.mjs'), 'utf8');
check('the fit-score CLI builds it from every queued row',
  fitSrc.indexOf('publishedStarts(jobs.filter(') !== -1
  && fitSrc.indexOf('publishedStarts(live)') === -1,
  fitSrc.indexOf('publishedStarts(live)') !== -1 ? 'STILL USES THE SLICE' : '');


/* ---- freshness: a posting inside its first week earns a small, visible bonus --
   Measured 2026-09-18: the interview application with a known posting date
   went in two days after it; the median across all 150 applications was
   twenty. Never on an unknown date, never past 100, visible in rank_why. */
{
  const dayMs = 86400000;
  const today = new Date().toISOString().slice(0, 10);
  const lastMonth = new Date(Date.now() - 40 * dayMs).toISOString().slice(0, 10);
  const freshRow = scoreOne({ ...JOB, salary_min: 200000, posted: today, dedupe_key: 'fresh' }, READABLE, ten);
  const staleRow = scoreOne({ ...JOB, salary_min: 200000, posted: lastMonth, dedupe_key: 'stale' }, READABLE, ten);
  const undated = scoreOne({ ...JOB, salary_min: 200000, posted: null, dedupe_key: 'undated' }, READABLE, ten);
  check('a posting from today scores FRESH_BONUS above the same posting from last month',
    freshRow.rank === staleRow.rank + FRESH_BONUS, `${freshRow.rank} vs ${staleRow.rank}`);
  check('an unknown posted date earns nothing, because unknown is not fresh',
    undated.rank === staleRow.rank && undated.fresh === false, `${undated.rank} vs ${staleRow.rank}`);
  check('the bonus is named in rank_why', /applying early/.test(rankWhy({ ...freshRow, job: JOB })), rankWhy({ ...freshRow, job: JOB }).slice(0, 120));
  check('and absent from a stale row\'s reason', !/applying early/.test(rankWhy({ ...staleRow, job: JOB })));
  check('the bonus cannot push a rank past 100', scoreOne({ ...JOB, posted: today }, READABLE, ten).rank <= 100);
  const edge = new Date(Date.now() - (FRESH_DAYS + 1) * dayMs).toISOString().slice(0, 10);
  check('day FRESH_DAYS + 1 is not fresh',
    scoreOne({ ...JOB, salary_min: 200000, posted: edge, dedupe_key: 'edge' }, READABLE, ten).fresh === false);
}

console.log(bad
  ? `\n${bad} FAILED`
  : '\npay is a percentile in the headline, unpriced is the median, and a weight typo fails');
process.exitCode = bad ? 1 : 0;
