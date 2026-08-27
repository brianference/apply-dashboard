/**
 * The applier must work the queue in the order the dashboard ranks it.
 *
 * The defect this exists to catch shipped silently: the ranking was rebuilt to
 * `rank_pct` and the applier kept sorting on the retired `match_pct`, so it
 * preferred postings whose description had never been read. Nothing failed,
 * because nothing tested the order.
 *
 * The last block runs the OLD comparator over the same cases and requires it
 * to FAIL. A test whose bad input still passes is not a test.
 *
 * Run: node apply/test-order.mjs
 */

import { compareCandidates, familyRank } from './order.mjs';
import { isVerdict, reopensOnAnswers, crashCapApplies } from './ledger-rules.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(56)} ${detail || ''}`);
};

const ashby = (o) => ({ url: 'https://jobs.ashbyhq.com/x/1', ...o });
const gh = (o) => ({ url: 'https://job-boards.greenhouse.io/x/jobs/1', ...o });

/** The regression, exactly as it appeared in the live queue on 2026-08-27. */
const REGRESSION = [
  ashby({ id: 'unranked-high-keyword', rank_pct: null, match_pct: 88 }),
  ashby({ id: 'ranked-low-keyword', rank_pct: 68, match_pct: 56 }),
];

/** @param {any[]} rows @param {(a:any,b:any)=>number} cmp @returns {string[]} */
const orderOf = (rows, cmp) => [...rows].sort(cmp).map(r => r.id);

check('an unranked posting never outranks a ranked one',
  orderOf(REGRESSION, compareCandidates)[0] === 'ranked-low-keyword',
  orderOf(REGRESSION, compareCandidates).join(' > '));

const RANKS = [
  ashby({ id: 'a-70', rank_pct: 70, match_pct: 10 }),
  ashby({ id: 'a-78', rank_pct: 78, match_pct: 10 }),
  ashby({ id: 'a-63', rank_pct: 63, match_pct: 99 }),
];
check('within a family, higher rank_pct is worked first',
  orderOf(RANKS, compareCandidates).join(',') === 'a-78,a-70,a-63',
  orderOf(RANKS, compareCandidates).join(' > '));

const FAMILIES = [
  { id: 'workday', url: 'https://x.wd1.myworkdayjobs.com/j', rank_pct: 99 },
  { id: 'ashby', url: 'https://jobs.ashbyhq.com/x/1', rank_pct: 10 },
  { id: 'greenhouse', url: 'https://job-boards.greenhouse.io/x/jobs/1', rank_pct: 20 },
  { id: 'lever', url: 'https://jobs.lever.co/x/1', rank_pct: 30 },
];
check('a submittable family still beats a higher-ranked dead end',
  orderOf(FAMILIES, compareCandidates).join(',') === 'ashby,greenhouse,lever,workday',
  orderOf(FAMILIES, compareCandidates).join(' > '));

const UNRANKED = [
  ashby({ id: 'u-40', rank_pct: null, match_pct: 40 }),
  ashby({ id: 'u-75', rank_pct: null, match_pct: 75 }),
];
check('among unranked postings the old score only breaks the tie',
  orderOf(UNRANKED, compareCandidates).join(',') === 'u-75,u-40');

check('a zero rank is a rank, not a missing one',
  orderOf([ashby({ id: 'zero', rank_pct: 0, match_pct: 1 }), ashby({ id: 'none', rank_pct: null, match_pct: 99 })], compareCandidates)[0] === 'zero');

check('familyRank is case-insensitive', familyRank('https://JOBS.ASHBYHQ.COM/x') === 0);
check('greenhouse and ashby are not the same lane', familyRank(gh({}).url) !== familyRank(ashby({}).url));

/* A rehearsal must not retire a posting. batch.mjs blocks on any recorded state
   it does not know to be retryable, so before this rule a dry run was a life
   sentence. */
check('a dry run is not a verdict about the posting', isVerdict('dry-run-ok') === false);
check('a real block still blocks', isVerdict('needs-email-code') === true);
check('a submission is still a verdict', isVerdict('submitted') === true);
check('no entry at all is not a verdict', isVerdict('') === false && isVerdict(null) === false);

/* A refusal that named its missing fields reopens when the answers change, and
   only then. Without this the answer is written and the row stays retired. */
check('a needs-answers row reopens when the bank changes',
  reopensOnAnswers({ state: 'needs-answers', answers: 'aaa' }, 'bbb') === true);
check('a needs-answers row stays shut on the same bank',
  reopensOnAnswers({ state: 'needs-answers', answers: 'aaa' }, 'aaa') === false);
check('an entry recorded before the bank was fingerprinted reopens once',
  reopensOnAnswers({ state: 'needs-answers' }, 'aaa') === true);
check('a changed bank does not reopen a captcha or a real submission',
  reopensOnAnswers({ state: 'captcha', answers: 'aaa' }, 'bbb') === false
  && reopensOnAnswers({ state: 'submitted', answers: 'aaa' }, 'bbb') === false);
check('nothing recorded is nothing to reopen', reopensOnAnswers(null, 'aaa') === false);

/* A crash is evidence about the driver. When the driver changes the count is a
   stale verdict, or a slow screenshot retires a good posting forever. */
check('the cap holds while the driver is unchanged',
  crashCapApplies({ crashCount: 2, driver: 'abc' }, 'abc') === true);
check('a changed driver gives the posting its attempts back',
  crashCapApplies({ crashCount: 2, driver: 'abc' }, 'xyz') === false);
check('under the cap is never blocked',
  crashCapApplies({ crashCount: 1, driver: 'abc' }, 'abc') === false);
check('an entry with no driver recorded is not capped',
  crashCapApplies({ crashCount: 5 }, 'abc') === false);
check('no entry is not capped', crashCapApplies(null, 'abc') === false);

/* The bad input. This is the comparator batch.mjs used until 2026-08-27; if the
   suite above still passes with it, the suite is decorative. */
const OLD = (a, b) => {
  const F = (u) => /ashbyhq/.test(u) ? 0 : /greenhouse/.test(u) ? 1 : /lever\.co/.test(u) ? 2 : /workable|smartrecruiters/.test(u) ? 3 : 4;
  const f = F(a.url || '') - F(b.url || '');
  return f || ((b.match_pct || 0) - (a.match_pct || 0));
};
check('the retired comparator FAILS the regression case',
  orderOf(REGRESSION, OLD)[0] === 'unranked-high-keyword',
  'old order: ' + orderOf(REGRESSION, OLD).join(' > '));
check('the retired comparator FAILS the rank-order case',
  orderOf(RANKS, OLD).join(',') !== 'a-78,a-70,a-63',
  'old order: ' + orderOf(RANKS, OLD).join(' > '));

console.log(bad ? `\n${bad} failing` : '\nall passing');
process.exit(bad ? 1 : 0);
