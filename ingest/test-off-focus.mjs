/**
 * The off-focus domain penalty, and the role gate that sits in front of it.
 *
 * Two different answers to two different questions, and getting them the wrong
 * way round is the bug this guards:
 *
 *   "Director of Product Marketing"     -> a different job family, EXCLUDED
 *   "Staff Product Manager, Marketing"  -> a real PM role in a domain Brian has
 *                                          not worked in, KEPT and de-ranked
 *
 * The penalty also has a specific way of failing silently. Its regex went
 * through a shell heredoc once, every \b became a literal backspace, and the
 * pattern matched nothing: the constant was defined, the reason was wired into
 * the row, the score never moved, and everything read as implemented. So this
 * asserts the matcher FIRES, not merely that it runs.
 *
 *   node ingest/test-off-focus.mjs
 */

import { roleEligible } from './location-eligible.mjs';
import { offFocusDomain } from './fit-score.mjs';
import { domainSignals } from './domain-eligible.mjs';

const failures = [];

/**
 * @param {boolean} pass
 * @param {string} what
 * @param {string} [detail]
 * @returns {void}
 */
function check(pass, what, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${what.padEnd(62)} ${detail}`);
  if (!pass) failures.push(what);
}

/* --- the role gate: product marketing is not product management --- */
for (const title of [
  'Director of Product Marketing, Investing',
  'Product Marketing - Manager / Senior Manager',
  'Senior Product Marketing Manager',
  'PMM, Growth'
]) {
  check(roleEligible(title).ok === false, `excluded as a different family: ${title}`);
}

/* --- and it must not take the product-management roles with it --- */
for (const title of [
  'Staff Product Manager, Marketing Pro',
  'Senior Product Manager',
  'Director of Product',
  'Principal Product Manager, AI',
  'Group Product Manager, Payments'
]) {
  check(roleEligible(title).ok === true, `still a product role: ${title}`);
}

/* --- marketing is an EXCLUSION now, not a penalty ---

   It was a 25-point off-focus penalty until 2026-09-03. Brian: a penalty still
   left "Staff Product Manager, Marketing Pro" at 41 percent and at the TOP of
   his $165k-this-week view, so remove them everywhere. Both halves are asserted
   rather than the old cases being deleted, because "the rule moved" is exactly
   the change that leaves one half of a system still believing the old thing. */
for (const title of [
  'Staff Product Manager, Marketing Pro',
  'Principal Product Manager, Demand Generation',
  'Senior PM, Martech Platform',
  'Product Manager, Campaign Management'
]) {
  const d = domainSignals({ title, company: 'X' }, null);
  check(d.ruled === true && d.domain === 'marketing',
    `ruled out as marketing: ${title}`, d.ruled ? d.domain : 'NOT RULED OUT');
  /* A row that is both excluded AND de-ranked would be double-counted the day
     somebody switches the domain back on from Advanced. */
  check(offFocusDomain(title) === null,
    `no longer carries the off-focus penalty: ${title}`,
    offFocusDomain(title) ? 'STILL PENALISED' : '');
}

/* --- and does not fire on everything else. "Marketplace" contains "market",
       which is exactly what the word boundaries are there to stop. --- */
for (const title of [
  'Senior Product Manager',
  'Product Manager, Payments',
  'Product Manager, Marketplace',
  'Principal Product Manager, Supermarket Logistics'
]) {
  check(offFocusDomain(title) === null, `not penalised: ${title}`,
    offFocusDomain(title) ? 'MATCHED WRONGLY' : '');
  const d = domainSignals({ title, company: 'X' }, null);
  check(!(d.ruled && d.domain === 'marketing'), `not ruled out as marketing: ${title}`,
    d.ruled ? d.domain : '');
}

/* The penalty mechanism is empty now, not broken. An empty rule that still
   claimed to penalise something is the worse failure, so say the honest thing. */
check(offFocusDomain('') === null, 'an empty title is not penalised');

/* The rule reads the TITLE only, for the same reason risk-compliance does:
   nearly every product description names marketing somewhere. */
const inDesc = domainSignals(
  { title: 'Senior Product Manager, Payments', company: 'X' },
  'You will partner closely with marketing and demand generation on campaign management.'
);
check(!(inDesc.ruled && inDesc.domain === 'marketing'),
  'marketing in the DESCRIPTION rules nothing out',
  inDesc.ruled ? inDesc.domain : '');

console.log(failures.length
  ? `\n${failures.length} FAILED`
  : '\nmarketing is excluded, not de-ranked, and only on the title');
process.exit(failures.length ? 1 : 0);
