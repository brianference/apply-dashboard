/**
 * Collapsing a middleman's relisting onto the employer's own posting, and the
 * two things that must never happen while doing it.
 *
 * Brian, 2026-09-18: collapse any Jobgether row whose title matches.
 *
 * The two failures that matter. Collapsing a generic title onto the wrong
 * employer: "Senior Product Manager" is listed by twenty named employers, and
 * picking one of them would mark a real posting as a duplicate of a job it is
 * not. And rewriting a submitted row: an application sent through the
 * middleman is history, and history is reported, never edited.
 *
 * Run: node ingest/test-collapse-relistings.mjs
 */

import { planCollapse, normTitle } from './collapse-relistings.mjs';
import { DUPLICATE_REASON } from './dedupe-repair.mjs';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(66)} ${detail ?? ''}`);
};

const JG = 'Jobgether (anonymized partner employer)';
const rows = [
  /* One named twin: collapses. */
  { dedupe_key: 'jg1', company: JG, title: 'Principal Product Manager, Capital Platform', status: 'queued', rank_pct: 58 },
  { dedupe_key: 'up1', company: 'Upstart', title: 'Principal Product Manager, Capital Platform', status: 'queued', rank_pct: 52, url: 'https://job-boards.greenhouse.io/upstart/jobs/1' },
  /* The middleman appends its own name; the twin does not. Still one twin. */
  { dedupe_key: 'jg2', company: JG, title: 'Senior Product Manager, Learner Platform - Jobgether', status: 'queued', rank_pct: 71 },
  { dedupe_key: 'cp1', company: 'CodePath', title: 'Senior Product Manager, Learner Platform', status: 'queued', rank_pct: 72, url: 'https://job-boards.greenhouse.io/codepath/jobs/2' },
  /* A generic title with several named employers: ambiguous, never collapsed. */
  { dedupe_key: 'jg3', company: JG, title: 'Senior Product Manager', status: 'queued', rank_pct: 60 },
  { dedupe_key: 'a1', company: 'Veeva Systems', title: 'Senior Product Manager', status: 'submitted', url: 'https://x/1' },
  { dedupe_key: 'a2', company: 'Tremendous', title: 'Senior Product Manager', status: 'queued', rank_pct: 76, url: 'https://x/2' },
  /* Submitted through the middleman: history, reported and left alone. */
  { dedupe_key: 'jg4', company: JG, title: 'Principal Product Manager, Growth', status: 'submitted', submitted_at: '2026-08-26' },
  { dedupe_key: 'up2', company: 'Upstart', title: 'Principal Product Manager, Growth', status: 'queued', rank_pct: 50, url: 'https://job-boards.greenhouse.io/upstart/jobs/3' },
  /* No named twin at all: kept, the employer may not be in the queue. */
  { dedupe_key: 'jg5', company: JG, title: 'Product Manager, LMS (Contract Position)', status: 'queued', rank_pct: 28 },
  /* A twin that is itself skipped does not count as live. */
  { dedupe_key: 'jg6', company: JG, title: 'Staff Product Manager, Attribution', status: 'queued', rank_pct: 43 },
  { dedupe_key: 'sa1', company: 'StackAdapt', title: 'Staff Product Manager, Attribution', status: 'skipped', url: 'https://x/3' },
  /* A named employer whose name merely CONTAINS the middleman's is not a relister. */
  { dedupe_key: 'nm1', company: 'Not Jobgether Ltd', title: 'Product Manager, Payments', status: 'queued', rank_pct: 40 }
];

const plan = planCollapse(rows);
const collapsedKeys = plan.collapse.map((c) => c.row.dedupe_key);

check('the one-twin row collapses onto its employer',
  collapsedKeys.includes('jg1') && plan.collapse.find((c) => c.row.dedupe_key === 'jg1').onto.company === 'Upstart');
check('the middleman\'s appended name does not stop the match',
  collapsedKeys.includes('jg2') && plan.collapse.find((c) => c.row.dedupe_key === 'jg2').onto.company === 'CodePath');

/* THE ONES THAT MATTER. */
check('a generic title shared by several employers is NOT collapsed',
  !collapsedKeys.includes('jg3') && plan.ambiguous.some((a) => a.row.dedupe_key === 'jg3'),
  `ambiguous: ${plan.ambiguous.map((a) => a.row.dedupe_key).join(',')}`);
check('a row submitted through the middleman is reported, never collapsed',
  !collapsedKeys.includes('jg4') && plan.submitted.some((s) => s.row.dedupe_key === 'jg4'));

check('a relisting with no named twin is kept',
  plan.kept.some((k) => k.dedupe_key === 'jg5') && !collapsedKeys.includes('jg5'));
check('a skipped twin is not live, so the relisting is kept',
  plan.kept.some((k) => k.dedupe_key === 'jg6') && !collapsedKeys.includes('jg6'));
check('the collapse list is exactly the two one-twin rows',
  collapsedKeys.length === 2 && collapsedKeys.includes('jg1') && collapsedKeys.includes('jg2'), collapsedKeys.join(','));
check('a named employer is never treated as a relister',
  !plan.kept.concat(plan.collapse.map((c) => c.row)).some((r) => r.dedupe_key === 'nm1'));

check('the reason written is the one the dashboard already labels',
  DUPLICATE_REASON === 'duplicate-posting', DUPLICATE_REASON);

check('normTitle strips the middleman suffix and remote markers',
  normTitle('Senior PM, Growth - Jobgether') === normTitle('Senior PM, Growth (Remote)'),
  `${normTitle('Senior PM, Growth - Jobgether')} | ${normTitle('Senior PM, Growth (Remote)')}`);
check('normTitle does not equate two different titles',
  normTitle('Senior Product Manager, Growth') !== normTitle('Senior Product Manager, Platform'));

console.log(bad
  ? `\n${bad} FAILED`
  : '\nrelistings collapse onto a single named employer, and generic titles and sent applications are left alone');
process.exitCode = bad ? 1 : 0;
