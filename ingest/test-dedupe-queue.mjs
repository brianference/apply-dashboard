/* Retroactive duplicate detection: finding postings already sitting side by
   side in the queue, regardless of which source or writer put them there. */
import { findDuplicateGroups, decideKeeper, duplicateWrite } from './dedupe-queue.mjs';

const pad = (s, n) => String(s).padEnd(n);
let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(name, 48)} ${detail || ''}`);
};

/* Kin: identical Ashby URL, different dedupe_key, one row from each of two
   writers -- caught on URL alone, exactly like the real queue. */
const kinA = { dedupe_key: 'kin|director, product management - platform & customer lifecycle', company: 'Kin', title: 'Director, Product Management - Platform & Customer Lifecycle', url: 'https://jobs.ashbyhq.com/kin/34551772-bf4b-47d8-afe9-d368b0a63ef9', status: 'queued', source: 'LinkedIn', rank_pct: 40, posted: '2026-08-27' };
const kinB = { dedupe_key: 'kin insurance|director, product management - platform & customer lifecycle', company: 'Kin Insurance', title: 'Director, Product Management - Platform & Customer Lifecycle', url: 'https://jobs.ashbyhq.com/kin/34551772-bf4b-47d8-afe9-d368b0a63ef9', status: 'queued', source: 'Ashby', rank_pct: 40, posted: '2026-08-27' };

/* Hopper: different URLs entirely (Ashby vs jobspresso), caught on
   normalised title alone -- a hyphen on one board, a comma on the other. */
const hopperA = { dedupe_key: 'hopper|principal product manager- conversational ai', company: 'Hopper', title: 'Principal Product Manager- Conversational AI', url: 'https://jobs.ashbyhq.com/hopper/241f7145-06b9-4ae5-969e-3cccaff85d98', status: 'queued', source: 'ashby', rank_pct: 45, posted: '2026-08-14' };
const hopperB = { dedupe_key: 'hopper|principal product manager, conversational ai', company: 'Hopper', title: 'Principal Product Manager, Conversational AI', url: 'https://jobspresso.co/job/principal-product-manager-conversational-ai/', status: 'queued', source: 'jobspresso', rank_pct: 32, posted: '2026-08-29' };

/* Bjak: two genuinely different roles that share almost every word. Must
   NOT be grouped -- CRITERIA.md's own Cisco example is why. */
const bjakA = { dedupe_key: 'bjak|product manager - ai stockbroking', company: 'Bjak', title: 'Product Manager - AI Stockbroking', url: 'https://jobs.ashbyhq.com/bjakcareer/609083d0-0de9-4266-98ea-e48d3ba15fcd', status: 'queued', source: 'Ashby', rank_pct: 50 };
const bjakB = { dedupe_key: 'bjak|product manager - ai stockbroking app', company: 'Bjak', title: 'Product Manager - AI Stockbroking App', url: 'https://jobs.ashbyhq.com/bjakcareer/4dcae284-6841-497e-a2a9-b1f4576a886d', status: 'queued', source: 'Ashby', rank_pct: 52 };

/* A skipped row must never be pulled into a group -- it is already off the
   list and re-flagging it would just be noise. */
const skippedTwin = { dedupe_key: 'kin|director product management dupe', company: 'Kin', title: 'Director, Product Management - Platform & Customer Lifecycle', url: 'https://jobs.ashbyhq.com/kin/34551772-bf4b-47d8-afe9-d368b0a63ef9', status: 'skipped', source: 'Indeed', rank_pct: null };

/* Stripe: one copy already submitted. The still-queued twin is the live
   risk of a second application and must be the one dropped, never the
   submitted row. */
const stripeSubmitted = { dedupe_key: 'stripe|staff product manager, payments', company: 'Stripe', title: 'Staff Product Manager, Payments', url: 'https://stripe.com/jobs/search?gh_jid=1', status: 'submitted', source: 'Greenhouse', rank_pct: null };
const stripeQueued = { dedupe_key: 'stripe|staff product manager - payments', company: 'Stripe', title: 'Staff Product Manager - Payments', url: 'https://www.workingnomads.com/jobs/staff-pm-payments-stripe', status: 'queued', source: 'Working Nomads', rank_pct: 32 };

const rows = [kinA, kinB, hopperA, hopperB, bjakA, bjakB, skippedTwin, stripeSubmitted, stripeQueued];
const groups = findDuplicateGroups(rows);

check('finds exactly 3 duplicate groups (Kin, Hopper, Stripe)', groups.length === 3, `got ${groups.length}`);

const findGroup = (dk) => groups.find((g) => g.some((r) => r.dedupe_key === dk));

const kinGroup = findGroup(kinA.dedupe_key);
check('Kin group has exactly the two Kin rows', !!kinGroup && kinGroup.length === 2, kinGroup ? kinGroup.map(r=>r.dedupe_key).join(' | ') : 'no group');
check('the skipped Kin twin is NOT pulled in', !!kinGroup && !kinGroup.some((r) => r.status === 'skipped'));

const hopperGroup = findGroup(hopperA.dedupe_key);
check('Hopper group has exactly the two Hopper rows', !!hopperGroup && hopperGroup.length === 2, hopperGroup ? hopperGroup.map(r=>r.dedupe_key).join(' | ') : 'no group');

check('Bjak is never grouped -- different roles, not a duplicate', !findGroup(bjakA.dedupe_key));

const stripeGroup = findGroup(stripeSubmitted.dedupe_key);
check('Stripe group has the submitted row and its queued twin', !!stripeGroup && stripeGroup.length === 2);

/* decideKeeper */
const kinDecision = decideKeeper(kinGroup);
/* Equal rank and equal posted date, so the tie-break is dedupe_key sorted
   ascending: 'kin insurance|...' sorts before 'kin|...' (a space is less
   than '|'). The point under test is determinism, not which one wins. */
check('Kin: equal rank, keeper picked deterministically by dedupe_key', kinDecision.keeper.dedupe_key === kinB.dedupe_key, kinDecision.keeper.dedupe_key);
check('Kin: exactly one row dropped', kinDecision.drop.length === 1);

const hopperDecision = decideKeeper(hopperGroup);
check('Hopper: the higher-ranked row is kept (45 over 32)', hopperDecision.keeper.dedupe_key === hopperA.dedupe_key, hopperDecision.keeper.dedupe_key);

const stripeDecision = decideKeeper(stripeGroup);
check('Stripe: the SUBMITTED row is always kept, never the higher-ranked one', stripeDecision.keeper.status === 'submitted', stripeDecision.keeper.dedupe_key);
check('Stripe: the queued twin is what gets dropped', stripeDecision.drop[0].dedupe_key === stripeQueued.dedupe_key);

const twoSubmitted = decideKeeper([
  { ...stripeSubmitted },
  { ...stripeSubmitted, dedupe_key: 'stripe|staff product manager, payments (mirror)', status: 'submitted' }
]);
check('two already-submitted rows: reported, nothing dropped', twoSubmitted.keeper === null && twoSubmitted.drop.length === 0, twoSubmitted.note);

/* duplicateWrite */
const w = duplicateWrite(stripeQueued, stripeSubmitted);
check('write clears rank_pct and pay_tier', /rank_pct = NULL/.test(w.sql) && /pay_tier = NULL/.test(w.sql));
check('write sets duplicate-posting', w.params.includes('duplicate-posting'));
check('write targets the dropped row, not the keeper', w.params.includes(stripeQueued.dedupe_key) && !w.params.includes(stripeSubmitted.dedupe_key));
check('write names the keeper in blocked_detail', w.params.some((p) => typeof p === 'string' && p.includes(stripeSubmitted.dedupe_key)));

console.log(bad ? `\n${bad} FAILED` : '\nduplicate detection catches the real cases and leaves the ambiguous one alone');
process.exitCode = bad ? 1 : 0;
