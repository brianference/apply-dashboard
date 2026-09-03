/**
 * Healthcare, construction, clearance, risk-compliance and hardware exclusion.
 *
 * Healthcare, construction and hardware are read from the description. Risk
 * and compliance is read from the TITLE: the words it looks for appear in
 * boilerplate that EVERY US posting carries, and HIPAA on its own already
 * ruled out Vanta. Two real false positives from the description-based rules
 * are fixtures here too, because a rule that empties the list is worse than
 * one that never ran.
 *
 * Hardware's false positives are the measured ones: a silicon-valley URL
 * slug, one bare-metal deployment target, and four weak cloud-SKU mentions.
 *
 *   node ingest/test-domain.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  domainSignals, withoutBenefits, withoutUrls, TOGGLEABLE_DOMAINS,
  rowsToDomainBlock, domainBlockWrite
} from './domain-eligible.mjs';
import { strip } from './fit-score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    'Financial planning tooling for the enterprise. ' + BENEFITS + ' ' + LEGAL],
  /* Inovalon "Senior Principal Product Manager - Infusion" was ruled out
     as clearance because `ts/sci` matched the "ts/Sci" inside
     "Arts/Sciences". That is a degree, not a clearance requirement. */
  ['Acme', 'Senior Product Manager',
    'Bachelor’s Degree in Arts/Sciences (B.A./B.S.) required. Own the payments platform.']
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

/* A link slug can decide a rule. The real TLDR URL is the silicon case;
   healthtech is the check that actually fails if stripping is removed,
   because silicon is a weak term and one hit would not trip the threshold. */
const TLDR_URL = 'https://www.inc.com/tldr-the-definitive-silicon-valley-tech-newsletter';
const HEALTHTECH_URL = 'https://www.inc.com/healthtech-b2b-environments';
check(!/silicon/i.test(withoutUrls(TLDR_URL)),
  'URL stripping removes a silicon-valley slug');
check(/silicon/i.test(withoutUrls('Our product runs on custom silicon.')),
  'real silicon language survives URL stripping');
check(!/healthtech/i.test(withoutUrls(HEALTHTECH_URL)),
  'URL stripping removes a healthtech slug');

const tldr = domainSignals(
  { company: 'TLDR', title: 'Product Manager, Applied AI' },
  'As covered in ' + TLDR_URL
);
check(!tldr.ruled,
  'silicon only inside an inc.com URL is not hardware',
  tldr.ruled ? `WRONGLY RULED OUT as ${tldr.domain} (${tldr.why})` : '');

const urlHealth = domainSignals(
  { company: 'Acme', title: 'Senior Product Manager' },
  'More at ' + HEALTHTECH_URL
);
check(!urlHealth.ruled,
  'healthtech only inside a URL is not healthcare',
  urlHealth.ruled ? `WRONGLY RULED OUT as ${urlHealth.domain} (${urlHealth.why})` : '');

/* ---- the threshold has to bite in both directions -------------------- */

check(!domainSignals({}, 'One passing mention of a hospital in a case study.').ruled,
  'a single weak mention does not rule a posting out');
check(domainSignals({}, 'patient patient clinician hospital nurse').ruled,
  'enough weak mentions do rule a posting out');

/* ---- risk-compliance is decided on the TITLE -------------------------- */

/* Brian, 2026-09-02: risk and compliance roles are boring. The three titles
   below are the live queue rows that prompted it. Searching the description
   would rule out almost every US posting, because legal boilerplate always
   mentions compliance -- HIPAA on its own already took Vanta out. */
const RISK_OUT = [
  ['Jobgether (anonymized partner employer)', 'Product Manager - Risk Compliance'],
  ['Pinterest', 'Product Manager II, Content Compliance'],
  ['Stripe', 'Product Manager - Compliance, Bridge'],
  ['Vanta', 'Senior Product Manager, GRC Platform'],
  ['Acme', 'Product Manager, Regulatory'],
  ['Acme', 'Product Manager, Governance, Risk']
];
for (const [company, title] of RISK_OUT) {
  const r = domainSignals({ company, title }, 'A normal product description.');
  check(r.ruled && r.domain === 'risk-compliance',
    `ruled out as risk-compliance: ${company}`,
    r.ruled ? `${r.domain} (${r.why})` : 'NOT RULED OUT');
}

const webflow = domainSignals(
  { company: 'Webflow', title: 'Staff Product Manager, Governance' },
  'Own data governance for the platform.'
);
check(!webflow.ruled,
  'Webflow Staff Product Manager, Governance is kept',
  webflow.ruled ? `WRONGLY RULED OUT as ${webflow.domain} (${webflow.why})` : '');

/* The whole reason this rule is title-first: a clean title with compliance
   language in the description must survive. Widening the search back to the
   description is the change that has to make this fail. */
const boilerplate = domainSignals(
  { company: 'Acme', title: 'Senior Product Manager, Platform' },
  'We comply with all applicable regulatory requirements.'
);
check(!boilerplate.ruled,
  'a clean title is kept even when the description talks about regulatory compliance',
  boilerplate.ruled ? `WRONGLY RULED OUT as ${boilerplate.domain} (${boilerplate.why})` : '');

const clean = domainSignals(
  { company: 'Stripe', title: 'Product Manager, Identity' },
  'Own identity and access for the payments platform.'
);
check(!clean.ruled,
  'a clean product title with a clean description is kept',
  clean.ruled ? `WRONGLY RULED OUT as ${clean.domain} (${clean.why})` : '');

check(TOGGLEABLE_DOMAINS.includes('risk-compliance'),
  'risk-compliance is switchable the way healthcare is');
check(TOGGLEABLE_DOMAINS.includes('hardware'),
  'hardware is switchable the way healthcare is');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check(/["']?risk-compliance["']?:\s*"Risk and compliance"/.test(html),
  'index.html names the badge for a row switched back on');
check(/hardware:\s*"Hardware"/.test(html),
  'index.html names the hardware badge for a row switched back on');

/* ---- applying the rule to rows already in the queue ------------------- */

const queuedRisk = [
  { dedupe_key: 'jg', company: 'Jobgether', title: 'Product Manager - Risk Compliance', status: 'queued' },
  { dedupe_key: 'pin', company: 'Pinterest', title: 'Product Manager II, Content Compliance', status: 'queued' },
  { dedupe_key: 'str', company: 'Stripe', title: 'Product Manager - Compliance, Bridge', status: 'queued' }
];
const submittedRisk = [
  { dedupe_key: 'cb', company: 'Coinbase', title: 'Group Product Manager, Compliance Agent Experience', status: 'submitted' },
  { dedupe_key: 'va', company: 'Vanta', title: 'Senior Product Manager, GRC Platform', status: 'submitted' }
];
const keepQueued = [
  { dedupe_key: 'wf', company: 'Webflow', title: 'Staff Product Manager, Governance', status: 'queued' }
];
const alreadySkipped = [
  { dedupe_key: 'sk', company: 'Stripe', title: 'Staff Product Manager, Risk Product Experience', status: 'skipped' }
];
const decided = rowsToDomainBlock([...queuedRisk, ...submittedRisk, ...keepQueued, ...alreadySkipped]);
const decidedKeys = decided.map((item) => item.row.dedupe_key);
check(decided.length === 3 &&
    decidedKeys.includes('jg') && decidedKeys.includes('pin') && decidedKeys.includes('str') &&
    decided.every((item) => item.domain.domain === 'risk-compliance'),
  'blocks the three queued risk-compliance titles',
  `got ${decided.length}: ${decidedKeys.join(',')}`);
check(!decidedKeys.includes('cb') && !decidedKeys.includes('va') &&
    decided.every((item) => item.row.status !== 'submitted'),
  'submitted Coinbase and Vanta compliance rows are never in the write list',
  decidedKeys.join(','));
check(!decidedKeys.includes('wf'),
  'Webflow Governance is not in the write list');
check(!decidedKeys.includes('sk'),
  'an already-skipped risk title is left on its original reason');

const dw = domainBlockWrite({ dedupe_key: 'jg' }, { domain: 'risk-compliance', why: 'title names a risk/compliance role: "Risk"' });
check(dw.params.includes('skipped') && /status\s*=\s*\?/.test(dw.sql),
  'domain write sets status skipped');
check(dw.params.includes('off-criteria'),
  'domain write sets blocked_reason off-criteria');
check(dw.params.includes('risk-compliance') && /excluded_domain\s*=\s*\?/.test(dw.sql),
  'domain write records excluded_domain so the switch can name the rule');
check(/rank_pct\s*=\s*NULL/.test(dw.sql) && /pay_tier\s*=\s*NULL/.test(dw.sql),
  'domain write clears rank_pct and pay_tier');
check(/status\s*!=\s*\?/.test(dw.sql) && dw.params.includes('submitted'),
  'domain write refuses a submitted row in the WHERE');

const regateSrc = fs.readFileSync(path.join(ROOT, 'ingest', 'regate.mjs'), 'utf8');
check(/rowsToDomainBlock\(/.test(regateSrc) && /domainBlockWrite\(/.test(regateSrc),
  'regate applies domain rules to queued rows, not only employers and salary skips');
/* Instacart Greenhouse 8014060, measured 2026-09-02: two headings in a
   row, "About the Job" then "Site Theming". After strip() they must not
   become the construction phrase `job site`. */
const instacartHtml = [
  '<p>editing platforms and design systems that balance retailer control and conversion.</p>',
  '<h2>About the Job</h2>',
  '<h2>Site Theming &amp; Brand Platform</h2>',
  '<p>Own the long term vision, strategy, and roadmap for site theming and content management.</p>'
].join('');
const instacart = domainSignals(
  { company: 'Instacart', title: 'Senior Product Manager, Retailer Platform' },
  strip(instacartHtml)
);
check(!instacart.ruled || instacart.domain !== 'construction',
  'Instacart Retailer Platform is not construction',
  instacart.ruled ? `${instacart.domain} (${instacart.why})` : '');

/* ---- hardware is decided on the DESCRIPTION -------------------------- */

/* Brian, 2026-09-02, on vCluster Labs "Staff Product Manager (vMetal)" at
   59%: i don't want hardware. The title says nothing. Treating silicon or
   bare metal as decisive on a single mention was wrong four times out of
   five; the keep cases below are those four, minus Jobgether which is the
   same shape as TLDR (one weak silicon). */
const vcluster = domainSignals(
  { company: 'vCluster Labs', title: 'Staff Product Manager (vMetal)' },
  'help own the systems that discover, provision, configure, and manage physical hardware, turning racks of bare metal into a programmable platform for AI Cloud operators and hyperscalers'
);
check(vcluster.ruled && vcluster.domain === 'hardware',
  'ruled out as hardware: vCluster Labs',
  vcluster.ruled ? vcluster.why : 'NOT RULED OUT');

const camunda = domainSignals(
  { company: 'Camunda', title: 'Product Manager, Self Managed Service' },
  'Deploy on Kubernetes, containers, bare-metal, and air-gapped environments.'
);
check(!camunda.ruled,
  'Camunda bare-metal beside Kubernetes and air-gapped is not hardware',
  camunda.ruled ? `WRONGLY RULED OUT as ${camunda.domain} (${camunda.why})` : '');

const vultr = domainSignals(
  { company: 'Vultr', title: 'Principal Technical PM, Strategic Accounts' },
  'Vultr cloud product lines include compute, kubernetes, storage, and bare metal. We work with silicon partners. Our racks and chassis SKUs sit beside those four cloud lines.'
);
check(!vultr.ruled,
  'Vultr four weak mentions with no decisive phrase is not hardware',
  vultr.ruled ? `WRONGLY RULED OUT as ${vultr.domain} (${vultr.why})` : '');

const jobgetherHw = domainSignals(
  { company: 'Jobgether', title: 'Technical Product Manager, AI Storage' },
  'storage, silicon, and technology ecosystem partners'
);
check(!jobgetherHw.ruled,
  'Jobgether silicon as a partner ecosystem is not hardware',
  jobgetherHw.ruled ? `WRONGLY RULED OUT as ${jobgetherHw.domain} (${jobgetherHw.why})` : '');

/* ---- marketing, decided on the title like risk-compliance ------------- */
const mkt = domainSignals(
  { company: 'Jobgether (anonymized partner employer)', title: 'Staff Product Manager, Marketing Pro' },
  null
);
check(mkt.ruled && mkt.domain === 'marketing',
  'Staff Product Manager, Marketing Pro is ruled out as marketing',
  mkt.ruled ? `${mkt.domain} (${mkt.why})` : 'NOT RULED OUT');

check(TOGGLEABLE_DOMAINS.indexOf('marketing') !== -1,
  'marketing can be switched back on from Advanced',
  TOGGLEABLE_DOMAINS.join(', '));

console.log(failures.length
  ? `\n${failures.length} FAILED`
  : '\nthe domain rule catches the right postings and leaves the rest alone');
process.exit(failures.length ? 1 : 0);
