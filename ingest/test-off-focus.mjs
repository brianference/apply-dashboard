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

/* --- the penalty fires on the domain, by title --- */
for (const title of [
  'Staff Product Manager, Marketing Pro',
  'Principal Product Manager, Demand Generation',
  'Senior PM, Martech Platform',
  'Product Manager, Campaign Management'
]) {
  const domain = offFocusDomain(title);
  check(domain !== null && domain.name === 'marketing', `penalised as off-focus: ${title}`,
    domain ? domain.name : 'NO MATCH');
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
}

console.log(failures.length
  ? `\n${failures.length} FAILED`
  : '\nexclusion and de-ranking are applied to the right titles');
process.exit(failures.length ? 1 : 0);
