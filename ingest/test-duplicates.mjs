/**
 * normalizedJobKey / sameJob, tested against the duplicates that actually got
 * through: three copies of one Hopper posting and two Applied Systems
 * postings queued twice each, none sharing a dedupe_key. And, just as
 * important, the cases that must NOT collapse -- Cisco's "Product Manager"
 * and "Product Manager - Partner Experience" are different jobs, and a guard
 * that merged them would quietly stop Brian applying to roles he wants.
 */
import { normalizedJobKey, sameJob } from './match.mjs';

const cases = [
  // [companyA, titleA, companyB, titleB, wantSame, why]
  ['Hopper', 'Principal Product Manager- Conversational AI',
   'Hopper', 'Principal Product Manager, Conversational AI',
   true, 'dash vs. comma before the qualifier'],
  ['Hopper', 'Principal Product Manager- Conversational AI',
   'Hopper', 'Principal Product Manager- Conversational AI - Hopper',
   true, 'aggregator appended the company name'],
  ['Applied Systems', 'Sr. AI Product Manager',
   'Applied Systems', 'Sr. AI Product Manager - Applied Systems',
   true, 'the same Applied Systems duplicate shape'],
  ['Applied Systems', 'Sr. Product Manager: AI Automation',
   'Applied Systems', 'Sr. Product Manager: AI Automation - Applied Systems',
   true, 'colon-qualified title, company suffix appended'],

  ['Cisco', 'Product Manager',
   'Cisco', 'Product Manager - Partner Experience',
   false, 'CISCO: different jobs, must stay distinct'],
  ['Adobe', 'Principal Product Manager',
   'Adobe', 'Principal Product Manager, Graph',
   false, 'a named product area is a different job, not decoration'],
  ['Applied Systems', 'Sr. AI Product Manager - Applied Systems',
   'Applied Systems', 'AI Product Manager - Applied Systems',
   false, 'seniority differs -- not the same posting'],
  ['Stripe', 'Staff Product Manager, Payments',
   'Stripe', 'Product Manager, Payments',
   false, 'seniority differs -- not the same posting'],
];

let bad = 0;
for (const [ca, ta, cb, tb, want, why] of cases) {
  const got = sameJob({ company: ca, title: ta }, { company: cb, title: tb });
  const ok = got === want;
  if (!ok) bad += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${String(got).padEnd(6)} ${(ca + ' | ' + ta).slice(0, 42).padEnd(44)} vs ${(cb + ' | ' + tb).slice(0, 42).padEnd(44)} ${why}`);
}

const pos = cases.filter((c) => c[4]).length;
const neg = cases.length - pos;
if (!pos || !neg) { console.log('FAIL the suite needs both matching and non-matching cases'); bad += 1; }

console.log('\n' + (bad ? bad + ' failed' : 'sameJob holds in both directions (' + pos + ' collapsed, ' + neg + ' kept distinct)'));

// normalizedJobKey itself should never throw on missing fields.
try {
  normalizedJobKey(undefined, undefined);
  normalizedJobKey('', '');
} catch (error) {
  console.log('FAIL normalizedJobKey threw on empty input: ' + error.message);
  bad += 1;
}

process.exit(bad ? 1 : 0);
