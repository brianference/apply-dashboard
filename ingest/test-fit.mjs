/* The fit score must be able to come out LOW, or it is decoration.
   Each case below is a job description chosen to produce a specific answer. */
import { fitScore, successScore, requirementsGate, yearsRequired, seniorityOf, boardRef } from './fit-score.mjs';

const pad = (s, n) => String(s).padEnd(n);
let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(name, 34)} ${detail || ''}`);
};

/* A job squarely in his record: AI, enterprise SaaS, reporting, analytics. */
const STRONG = `We are hiring a Senior Product Manager for our enterprise SaaS reporting
platform. You will own the roadmap for AI and LLM powered analytics, work cross-functional
with design and engineering, run experimentation with tools like Amplitude, and build
dashboards for business customers. Experience with B2B enterprise customers required.
5+ years of product experience.`.repeat(3);

/* A job almost entirely outside it. */
const WEAK = `Senior Product Manager, Advertising Platform. You will own our programmatic
DSP and ad server, drive brand safety, and partner on campaign manager tooling. Experience
in ad tech and marketplace two-sided dynamics essential. You will also shape our mobile iOS
and Android app store presence and own growth loops and paid acquisition. Supply chain and
logistics exposure a plus. 10+ years of product experience required.`.repeat(3);

/* Names almost nothing measurable. */
const VAGUE = `We want a great product manager. You will do product things and delight
customers. Come join a rocketship. We value ownership and bias for action.`.repeat(3);

const strong = fitScore(STRONG);
const weak = fitScore(WEAK);
const vague = fitScore(VAGUE);

check('strong JD scores high', strong && strong.pct >= 70, strong ? `${strong.pct}% over ${strong.askedCount} concepts` : 'null');
check('weak JD scores LOW', weak && weak.pct <= 35, weak ? `${weak.pct}% gaps: ${weak.gaps.join(',')}` : 'null');
check('strong beats weak by a mile', strong && weak && (strong.pct - weak.pct) >= 40, strong && weak ? `${strong.pct} vs ${weak.pct}` : '');
check('vague JD returns null, not a guess', vague === null, vague ? `wrongly scored ${vague.pct}` : 'null as required');
check('empty JD returns null', fitScore('') === null);
check('every point cites a source', !strong || strong.hits.every(h => h.includes(' - ')), strong ? `${strong.hits.length} cited` : '');

/* years + seniority */
check('reads "10+ years"', yearsRequired(WEAK) === 10, String(yearsRequired(WEAK)));
check('reads "5+ years"', yearsRequired(STRONG) === 5, String(yearsRequired(STRONG)));
check('no number means null', yearsRequired(VAGUE) === null);
check('seniority: VP', seniorityOf('VP, Product Management') === 5);
check('seniority: principal', seniorityOf('Principal Product Manager') === 3);
check('seniority: senior', seniorityOf('Senior Product Manager') === 2);
check('seniority: associate', seniorityOf('Associate Product Manager') === 0);

/* success must drop for the things that really do reduce his odds */
const base = successScore({ title: 'Senior Product Manager' }, STRONG);
const vp = successScore({ title: 'VP, Product' }, STRONG);
const clearance = successScore({ title: 'Senior Product Manager' }, STRONG + ' Requires an active TS/SCI security clearance.');
const closed = successScore({ title: 'Senior Product Manager', blocked_reason: 'posting-closed' }, STRONG);
check('VP scores far below senior', vp.pct < base.pct - 30, `${base.pct} -> ${vp.pct}`);
check('clearance craters it', clearance.pct < base.pct - 30, `${base.pct} -> ${clearance.pct}`);
check('a closed posting craters it', closed.pct < base.pct - 25, `${base.pct} -> ${closed.pct}`);
check('a 10-year ask lowers it', successScore({ title: 'Senior Product Manager' }, WEAK).pct < base.pct, '');

/* the gate */
check('gate rejects San Francisco', !requirementsGate({ title: 'Senior Product Manager', work_type: 'San Francisco, CA' }).ok);
check('gate rejects program manager', !requirementsGate({ title: 'Senior Technical Program Manager', work_type: 'Remote US' }).ok);
check('gate rejects published $120k', !requirementsGate({ title: 'Senior Product Manager', work_type: 'Remote US', salary_max: 120000 }).ok);
check('gate ALLOWS unknown salary', requirementsGate({ title: 'Senior Product Manager', work_type: 'Remote US' }).ok);
check('gate allows a good one', requirementsGate({ title: 'Senior Product Manager', work_type: 'Remote US', salary_max: 220000 }).ok);

/* board refs */
check('greenhouse url parses', boardRef('https://job-boards.greenhouse.io/mercury/jobs/6126980004')?.ats === 'greenhouse');
check('ashby url parses', boardRef('https://jobs.ashbyhq.com/openai/05a8cae8-81bd-4f7b-bc48-41ef1bd67e5d')?.ats === 'ashby');
check('aggregator url is unreadable', boardRef('https://himalayas.app/jobs/foo') === null);

console.log(bad ? `\n${bad} FAILED` : '\nthe fit score can come out low, and does');
process.exitCode = bad ? 1 : 0;

/* security detection: the real Delinea text must rule out; one passing mention must not */
import { securitySignals } from './fit-score.mjs';
/* The opening of Delinea's own posting, read from the live board on 2026-08-26
   and quoted here. Inline rather than loaded from ingest/out/jd-cache, which is
   gitignored: a test that needs an uncommitted file cannot run in CI, and this
   one silently could not have. */
const DELINEA = `About Delinea: Delinea is a pioneer in securing human and machine
identities through intelligent, centralized authorization, empowering organizations to
seamlessly govern their interactions across the modern enterprise. Leveraging AI-powered
intelligence, Delinea's leading cloud-native Identity Security Platform applies context
throughout the entire identity lifecycle across cloud and traditional infrastructure,
data, SaaS applications, and AI. It is the only platform that enables you to discover all
identities, assign appropriate access levels, detect irregularities, and respond to
threats in real-time.`;
const s1 = securitySignals(DELINEA);
console.log(`${s1.ruled ? 'ok  ' : 'FAIL'} ${'real Delinea JD ruled out'.padEnd(34)} ${s1.why}`);
const benign = 'We build an AI analytics platform. Our team values security and privacy. 5+ years product experience.';
const s2 = securitySignals(benign);
console.log(`${!s2.ruled ? 'ok  ' : 'FAIL'} ${'one mention does NOT rule out'.padEnd(34)} ${s2.why || 'kept'}`);
if (!s1.ruled || s2.ruled) process.exitCode = 1;

/* The salary START floor, given by Brian on 2026-08-27. */
{
  const cases = [
    [{ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 125000, salary_max: 201000 }, false, 'LIBERTY MUTUAL: the one he flagged'],
    [{ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 110000, salary_max: 300000 }, false, 'starts below it'],
    [{ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 95000,  salary_max: 145000 }, false, 'low band'],
    [{ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 130000, salary_max: 200000 }, false, 'still below the $160k floor'],
    [{ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 160000, salary_max: 200000 }, true,  'exactly at the floor passes'],
    [{ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 159999, salary_max: 400000 }, false, 'one dollar below does not'],
    [{ title: 'Senior Product Manager', work_type: 'Remote US', salary_min: 180000, salary_max: 250000 }, true,  'a good band'],
    [{ title: 'Senior Product Manager', work_type: 'Remote US', salary_max: 200000 }, true,  'no published start is unknown, not low'],
    [{ title: 'Senior Product Manager', work_type: 'Remote US' }, true, 'no salary at all is still fine'],
  ];
  let bad = 0;
  for (const [job, want, note] of cases) {
    const got = requirementsGate(job, null);
    const ok = got.ok === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${('min ' + (job.salary_min || '-') + ' max ' + (job.salary_max || '-')).padEnd(26)} ${String(got.ok).padEnd(5)} ${note}`);
  }
  console.log(bad ? `\n${bad} SALARY-START CASES FAILED` : '\na published start at or below $120k is refused, an unknown one is not');
  if (bad) process.exitCode = 1;
}
