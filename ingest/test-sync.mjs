/* Every rejection reason must be reachable. A filter nobody can trip is not a
   filter -- so each case here is an input CHOSEN to fail one specific rule. */
import { decide, normalizeUrl } from './sync-to-d1.mjs';
const existing = [
  { dedupe_key: 'acme|senior product manager', url: 'https://job-boards.greenhouse.io/acme/jobs/111' },
  { dedupe_key: 'other|whatever',              url: 'https://jobs.lever.co/beta/abc-123' },
];
const cands = [
  { company: 'Acme',  title: 'Senior Product Manager',            url: 'https://x.test/1',  work_type: 'Remote US' },
  { company: 'Beta',  title: 'Director of Product',               url: 'https://jobs.lever.co/beta/abc-123?utm_source=x', work_type: 'Remote US' },
  { company: 'Gamma', title: 'Senior Engineering Manager, Product', url: 'https://x.test/3', work_type: 'Remote US' },
  { company: 'Delta', title: 'Product Manager, Payments',         url: 'https://x.test/4',  work_type: 'Berlin, Germany' },
  { company: 'Eps',   title: 'Principal Product Manager, AI',     url: '',                  work_type: 'Remote US' },
  { company: 'Zeta',  title: 'Staff Product Manager, AI Platform', url: 'https://x.test/6', work_type: 'Remote United States' },
  { company: 'Zeta',  title: 'Staff Product Manager, AI Platform', url: 'https://x.test/7', work_type: 'Remote United States' },
  /* Hopper, 2026-09-03: Ashby's own listing ("Principal Product Manager-
     Conversational AI") and jobspresso's copy of it ("Principal Product
     Manager, Conversational AI") differ in dedupe_key and URL -- an exact
     match on either misses it -- but are the same posting once punctuation
     is normalised. */
  { company: 'Hopper', title: 'Principal Product Manager, Conversational AI', url: 'https://jobspresso.co/job/principal-product-manager-conversational-ai/', work_type: 'Remote' },
];
const existingWithHopper = [
  ...existing,
  { dedupe_key: 'hopper|principal product manager- conversational ai', url: 'https://jobs.ashbyhq.com/hopper/241f7145-06b9-4ae5-969e-3cccaff85d98', company: 'Hopper', title: 'Principal Product Manager- Conversational AI' },
];
const { fresh, rejected } = decide(cands, existingWithHopper);
const want = { role: 1, location: 1, "duplicate-key": 2, "duplicate-url": 1, "duplicate-job": 1, "no-url": 1 }; /* Zeta#2 is an in-batch key collision, which is the same rejection */
let bad = 0;
for (const [k, v] of Object.entries(want)) {
  const got = rejected[k];
  const ok = got === v;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${k.padEnd(14)} want ${v} got ${got}`);
}
const okFresh = fresh.length === 1 && fresh[0].company === 'Zeta';
if (!okFresh) bad++;
console.log(`${okFresh ? 'ok  ' : 'FAIL'} ${'fresh'.padEnd(14)} want 1 Zeta (second copy deduped in-batch) got ${fresh.length} ${fresh.map(f=>f.company).join(',')}`);
const nu = normalizeUrl('https://WWW.Jobs.Lever.co/beta/abc-123/?utm_source=x&gh_jid=9');
const okNorm = nu === 'jobs.lever.co/beta/abc-123?gh_jid=9';
if (!okNorm) bad++;
console.log(`${okNorm ? 'ok  ' : 'FAIL'} ${'normalizeUrl'.padEnd(14)} got ${nu}`);
console.log(bad ? `\n${bad} FAILED` : '\nevery rejection reason fires on an input built to trip it');
process.exitCode = bad ? 1 : 0;
