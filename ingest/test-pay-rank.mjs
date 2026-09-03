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
  RANK_FIT_WEIGHT, RANK_SUCCESS_WEIGHT, RANK_PAY_WEIGHT,
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

check('fit 80, success 60, pay 90 is round(32 + 21 + 22.5) = 76',
  rankBlend(80, 60, 90) === 76, String(rankBlend(80, 60, 90)));

check('fit weight is 0.40', RANK_FIT_WEIGHT === 0.40, String(RANK_FIT_WEIGHT));
check('success weight is 0.35', RANK_SUCCESS_WEIGHT === 0.35, String(RANK_SUCCESS_WEIGHT));
check('pay weight is 0.25', RANK_PAY_WEIGHT === 0.25, String(RANK_PAY_WEIGHT));
check('weights sum to 1.0 -- a future 0.95 would silently compress every score',
  RANK_FIT_WEIGHT + RANK_SUCCESS_WEIGHT + RANK_PAY_WEIGHT === 1,
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

/* ---- fit === null still returns success * 0.6 and ignores pay ------- */

const unreadHigh = scoreOne(
  { ...JOB, salary_min: 400000, dedupe_key: 'unread' },
  null,
  [160000, 180000, 200000, 400000]
);
check('unread description has fit null', unreadHigh.fit === null);
check('unread rank is round(success * 0.6), ignoring a top-of-list pay band',
  unreadHigh.rank === Math.round(unreadHigh.success.pct * RANK_UNREAD_SUCCESS_WEIGHT),
  `rank=${unreadHigh.rank} success=${unreadHigh.success.pct} payTerm=${unreadHigh.payTerm}`);
check('unread rank is NOT the three-term blend -- that would be mixing pay in',
  unreadHigh.rank !== rankBlend(0, unreadHigh.success.pct, unreadHigh.payTerm),
  `rank=${unreadHigh.rank} blendIfPayCounted=${rankBlend(0, unreadHigh.success.pct, unreadHigh.payTerm)}`);

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

/* ---- ORDERING: the behaviour Brian asked for ------------------------
   Today's two-term blend ranks the lower-paying row higher. The new blend
   reverses them. That is the only case that proves the change did something. */

const lowPay = { fit: 80, success: 80, pay: 10 };
const highPay = { fit: 60, success: 60, pay: 90 };
const oldOf = (row) => Math.round(row.fit * 0.55 + row.success * 0.45);
const newOf = (row) => rankBlend(row.fit, row.success, row.pay);

check("today's blend ranks the lower-paying row higher",
  oldOf(lowPay) > oldOf(highPay),
  `old low-pay ${oldOf(lowPay)} vs high-pay ${oldOf(highPay)}`);
check('the new blend reverses them',
  newOf(highPay) > newOf(lowPay),
  `new high-pay ${newOf(highPay)} vs low-pay ${newOf(lowPay)}`);

/* Same claim through scoreOne, so a blend function the scorer never calls
   cannot satisfy the suite. Same description, different pay and a modest
   success gap (Senior vs Principal): today the lower-paying Senior wins on
   success, and the new blend has to reverse them on pay. A weaker JD at
   $280k does not reverse -- fit 0 vs 87 swamps the pay term -- which is
   why these two share a description. */
const dist = [160000, 170000, 180000, 190000, 200000, 210000, 220000, 230000, 240000, 250000, 260000, 270000, 280000];
const lowPayRow = scoreOne(
  { ...JOB, title: 'Senior Product Manager', salary_min: 160000, dedupe_key: 'low' }, READABLE, dist
);
const highPayRow = scoreOne(
  { ...JOB, title: 'Principal Product Manager', salary_min: 280000, dedupe_key: 'high' }, READABLE, dist
);
const oldLow = lowPayRow.fit
  ? Math.round(lowPayRow.fit.pct * 0.55 + lowPayRow.success.pct * 0.45)
  : null;
const oldHigh = highPayRow.fit
  ? Math.round(highPayRow.fit.pct * 0.55 + highPayRow.success.pct * 0.45)
  : null;
check('scoreOne: two rows where today would rank the lower-paying one higher',
  oldLow != null && oldHigh != null && oldLow > oldHigh,
  `old low-pay ${oldLow} vs high-pay ${oldHigh} (fit ${lowPayRow.fit && lowPayRow.fit.pct} vs ${highPayRow.fit && highPayRow.fit.pct})`);
check('scoreOne: the new blend reverses them',
  highPayRow.rank > lowPayRow.rank,
  `new high-pay ${highPayRow.rank} vs low-pay ${lowPayRow.rank} (payTerm ${highPayRow.payTerm} vs ${lowPayRow.payTerm})`);

/* ---- known-bad: a temp copy with one weight changed MUST fail -------
   Never in the working tree. If this block starts passing because the copy
   still scores 76, the suite is decorative. */

const src = fs.readFileSync(path.join(ROOT, 'ingest', 'fit-score.mjs'), 'utf8');
check('the source names RANK_PAY_WEIGHT = 0.25 so a temp copy can change it',
  /export const RANK_PAY_WEIGHT = 0\.25/.test(src));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-rank-'));
const ingestUrl = pathToFileURL(path.join(ROOT, 'ingest')).href.replace(/\/$/, '');
const brokenSrc = src
  .replace('export const RANK_PAY_WEIGHT = 0.25', 'export const RANK_PAY_WEIGHT = 0.10')
  .replace(/from '\.\//g, `from '${ingestUrl}/`);
const brokenPath = path.join(tmp, 'fit-score.mjs');
fs.writeFileSync(brokenPath, brokenSrc);
const broken = await import(pathToFileURL(brokenPath).href);

const brokenBlend = broken.rankBlend(80, 60, 90);
const brokenSum = broken.RANK_FIT_WEIGHT + broken.RANK_SUCCESS_WEIGHT + broken.RANK_PAY_WEIGHT;
check('TEMP COPY with pay weight 0.10 FAILS the hand-worked 76',
  brokenBlend !== 76, `got ${brokenBlend}`);
check('TEMP COPY with pay weight 0.10 FAILS the weights-sum-to-1.0 assertion',
  brokenSum !== 1, `sum=${brokenSum}`);
check('the real module still scores that case 76 after the copy was broken',
  rankBlend(80, 60, 90) === 76);

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
check('daily.mjs builds the distribution from every queued row',
  dailySrc.indexOf('publishedStarts(all.filter(') !== -1
  && dailySrc.indexOf('publishedStarts(needsRank') === -1,
  dailySrc.indexOf('publishedStarts(needsRank') !== -1 ? 'STILL USES THE BATCH' : '');
const fitSrc = fs.readFileSync(path.join(ROOT, 'ingest', 'fit-score.mjs'), 'utf8');
check('the fit-score CLI builds it from every queued row',
  fitSrc.indexOf('publishedStarts(jobs.filter(') !== -1
  && fitSrc.indexOf('publishedStarts(live)') === -1,
  fitSrc.indexOf('publishedStarts(live)') !== -1 ? 'STILL USES THE SLICE' : '');

console.log(bad
  ? `\n${bad} FAILED`
  : '\npay is a percentile in the headline, unpriced is the median, and a weight typo fails');
process.exitCode = bad ? 1 : 0;
