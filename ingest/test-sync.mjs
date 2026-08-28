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
];
const { fresh, rejected } = decide(cands, existing);
const want = { role: 1, location: 1, "duplicate-key": 2, "duplicate-url": 1, "no-url": 1 }; /* Zeta#2 is an in-batch key collision, which is the same rejection */
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

/* Real duplicates found in the live queue on 2026-08-28: BuiltIn re-lists a
   job already captured from its own ATS and tags the URL with its own
   tracking params. Same job, missed because those params weren't stripped. */
const leverA = normalizeUrl('https://jobs.lever.co/arcadia/8d01e985-fc84-4097-ab31-ca2a328d8e11');
const leverB = normalizeUrl('https://jobs.lever.co/arcadia/8d01e985-fc84-4097-ab31-ca2a328d8e11/apply?lever-origin=applied&lever-source%5B%5D=BuiltInNationwide');
const okLever = leverA === leverB;
if (!okLever) bad++;
console.log(`${okLever ? 'ok  ' : 'FAIL'} ${'normalizeUrl'.padEnd(14)} Lever + BuiltIn re-scrape collapse to the same URL (${leverA} / ${leverB})`);

const icimsA = normalizeUrl('https://careers-appliedsystems.icims.com/jobs/7631/sr.-ai-product-manager/job');
const icimsB = normalizeUrl('https://careers-appliedsystems.icims.com/jobs/7631/sr.-ai-product-manager/job?hub=15&ss=1&mode=job&iis=BuiltInNationwide&iisn=BuiltInNationwide');
const okIcims = icimsA === icimsB;
if (!okIcims) bad++;
console.log(`${okIcims ? 'ok  ' : 'FAIL'} ${'normalizeUrl'.padEnd(14)} iCIMS + BuiltIn re-scrape collapse on the numeric job id (${icimsA} / ${icimsB})`);

/* decide() end-to-end: the same duplicate, arriving as a fresh candidate
   against an existing row whose title and URL both differ. */
const dupExisting = [
  { dedupe_key: 'arcadia|principal product manager, ai product',
    company: 'Arcadia', title: 'Principal Product Manager, AI Product',
    url: 'https://jobs.lever.co/arcadia/8d01e985-fc84-4097-ab31-ca2a328d8e11' }
];
const dupCandidate = [
  { company: 'Arcadia', title: 'Principal Product Manager, AI Product - Arcadia',
    url: 'https://jobs.lever.co/arcadia/8d01e985-fc84-4097-ab31-ca2a328d8e11/apply?lever-origin=applied&lever-source%5B%5D=BuiltInNationwide',
    work_type: 'remote / Remote (USA) / Full-time' }
];
const dupResult = decide(dupCandidate, dupExisting);
const okDup = dupResult.fresh.length === 0 && dupResult.rejected['duplicate-url'] === 1;
if (!okDup) bad++;
console.log(`${okDup ? 'ok  ' : 'FAIL'} ${'decide'.padEnd(14)} BuiltIn re-scrape of an existing row is rejected, not re-queued (fresh=${dupResult.fresh.length}, rejected=${JSON.stringify(dupResult.rejected)})`);

/* A title-suffix duplicate with no shared URL structure at all -- the
   signature check is the only thing that can catch this one. */
const sigExisting = [
  { dedupe_key: 'lyra health|lead product manager, data and ai',
    company: 'Lyra Health', title: 'Lead Product Manager, Data and AI',
    url: 'https://jobs.lever.co/lyrahealth/e3d731e8-eea0-4ae4-bd9a-5624b91ca129' }
];
const sigCandidate = [
  { company: 'Lyra Health', title: 'Lead Product Manager, Data and AI - Lyra Health',
    url: 'https://an-aggregator.example/totally-different-path?id=999', work_type: 'Remote US' }
];
const sigResult = decide(sigCandidate, sigExisting);
const okSig = sigResult.fresh.length === 0 && sigResult.rejected['duplicate-signature'] === 1;
if (!okSig) bad++;
console.log(`${okSig ? 'ok  ' : 'FAIL'} ${'decide'.padEnd(14)} "- CompanyName" suffix on an unrelated URL is caught by signature (fresh=${sigResult.fresh.length}, rejected=${JSON.stringify(sigResult.rejected)})`);

/* Two genuinely different roles at the same company must NOT collapse --
   the Cisco counter-example from CRITERIA.md. */
const distinctExisting = [
  { dedupe_key: 'cisco|product manager', company: 'Cisco', title: 'Product Manager',
    url: 'https://x.test/cisco-1' }
];
const distinctCandidate = [
  { company: 'Cisco', title: 'Product Manager - Partner Experience',
    url: 'https://x.test/cisco-2', work_type: 'Remote US' }
];
const distinctResult = decide(distinctCandidate, distinctExisting);
const okDistinct = distinctResult.fresh.length === 1;
if (!okDistinct) bad++;
console.log(`${okDistinct ? 'ok  ' : 'FAIL'} ${'decide'.padEnd(14)} a genuinely different role at the same company is NOT collapsed (fresh=${distinctResult.fresh.length})`);

console.log(bad ? `\n${bad} FAILED` : '\nevery rejection reason fires on an input built to trip it');
process.exitCode = bad ? 1 : 0;
