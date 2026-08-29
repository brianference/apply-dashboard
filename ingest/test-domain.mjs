/**
 * Healthcare, construction and clearance exclusion, read from the description.
 *
 * This rule is dangerous in a way the others are not: the words it looks for
 * appear in boilerplate that EVERY US posting carries. Two real false positives
 * came out of the first run and both are fixtures here, because a rule that
 * empties the list is worse than one that never ran.
 *
 *   node ingest/test-domain.mjs
 */

import { domainSignals, withoutBenefits } from './domain-eligible.mjs';

const failures = [];

/**
 * @param {boolean} pass
 * @param {string} what
 * @param {string} [detail]
 * @returns {void}
 */
function check(pass, what, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${what.padEnd(64)} ${detail}`);
  if (!pass) failures.push(what);
}

/* ---- must be ruled out ---------------------------------------------- */

const RULED = [
  ['healthcare', 'SmarterDx', 'Group Product Manager, SmarterDenials',
    'We are looking for 6 years of product management experience within B2B, healthtech environments. You will work with health system partners.'],
  ['healthcare', 'Abridge', 'Forward Deployed Product Manager',
    'Our product turns the patient-clinician conversation into clinical documentation.'],
  ['healthcare', 'Aledade', 'Senior PM',
    'We build for value-based care and primary care practices across the country.'],
  ['clearance', 'Virtualitics', 'Staff Product Manager',
    'This role requires an active Security Clearance at the TS/SCI level.'],
  ['construction', 'Procore', 'Product Manager',
    'Construction management software for the general contractor, from preconstruction through punch list.']
];
for (const [domain, company, title, jd] of RULED) {
  const r = domainSignals({ company, title }, jd);
  check(r.ruled && r.domain === domain, `ruled out as ${domain}: ${company}`,
    r.ruled ? r.why : 'NOT RULED OUT');
}

/* ---- must NOT be ruled out ------------------------------------------ */

/* Benefits boilerplate. Nearly every US posting carries this, and counting it
   would rule out most of the list. */
const BENEFITS = 'We offer medical, dental and vision insurance, mental health support, '
  + 'a health savings account, life insurance and a 401(k) match.';

/* Legally required notices. Their TITLES contain the words these rules look
   for. Elastic was ruled out as needing a clearance because of the first one. */
const LEGAL = 'Employee Polygraph Protection Act (EPPA) Poster. Family and Medical Leave Act '
  + '(FMLA) notice. Know Your Rights. E-Verify participant. Equal Employment Opportunity.';

const KEPT = [
  ['Vanta', 'Director of Product, G&C',
    'From automating security monitoring for compliance standards like SOC 2, HIPAA and ISO 27001 to the leading Trust Management Platform. ' + BENEFITS],
  ['Elastic', 'Senior Product Manager, Control Plane',
    'Build the control plane for our search platform. ' + LEGAL + ' ' + BENEFITS],
  ['Stripe', 'Product Manager, Identity',
    'Own identity and access for the payments platform. ' + BENEFITS + ' ' + LEGAL],
  ['PeopleGrove', 'Senior Product Manager',
    'A mentorship platform for universities. ' + BENEFITS],
  ['Coinbase', 'Senior Enterprise Product Manager, FP&A',
    'Financial planning tooling for the enterprise. ' + BENEFITS + ' ' + LEGAL]
];
for (const [company, title, jd] of KEPT) {
  const r = domainSignals({ company, title }, jd);
  check(!r.ruled, `kept: ${company}`, r.ruled ? `WRONGLY RULED OUT as ${r.domain} (${r.why})` : '');
}

/* ---- the stripper itself -------------------------------------------- */

check(!/medical/i.test(withoutBenefits('We offer medical, dental and vision.')),
  'benefits language is removed before matching');
check(!/polygraph/i.test(withoutBenefits('Employee Polygraph Protection Act poster')),
  'the EPPA notice is removed before matching');
check(/patient/i.test(withoutBenefits('Our product improves patient outcomes.')),
  'real domain language survives the stripper');

/* ---- the threshold has to bite in both directions -------------------- */

check(!domainSignals({}, 'One passing mention of a hospital in a case study.').ruled,
  'a single weak mention does not rule a posting out');
check(domainSignals({}, 'patient patient clinician hospital nurse').ruled,
  'enough weak mentions do rule a posting out');

console.log(failures.length
  ? `\n${failures.length} FAILED`
  : '\nthe domain rule catches the right postings and leaves the rest alone');
process.exit(failures.length ? 1 : 0);
