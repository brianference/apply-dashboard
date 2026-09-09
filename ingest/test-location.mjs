/**
 * Brian's two standing filters, tested against the REAL strings in his queue.
 *
 * Both rules exist because HE caught the miss, not the system: an Amplitude
 * role listed "San Francisco, CA" sat at 75% near the top of the list, and a
 * "Senior Engineering Manager, Enterprise AI Product" was sitting in a list
 * meant for product roles. A filter that only ever says yes would pass every
 * eligible case below and still ship both, so the REJECTIONS are the point.
 */
import fs from 'node:fs';
import { locationEligible, roleEligible } from './location-eligible.mjs';

/** Counts blocks that actually executed, so a skipped one cannot pass silently. */
let BLOCKS_RUN = 0;

const loc = [
  ['Remote', '', true, 'the plain case'],
  ['Remote (US)', '', true, 'remote, US-fenced'],
  ['Remote (US/Canada)', '', true, 'US is included'],
  ['Fully remote USA', '', true, 'spelled out'],
  ['-REMOTE, USA-', '', true, 'the odd formatting in the queue'],
  ['Anywhere in the World | Full-Time', '', true, 'worldwide includes him'],
  ['New York, San Francisco or Remote', '', true, 'remote offered as an ALTERNATIVE'],
  /* Was `true, 'remote is one of the options'` until 2026-08-26. Brian ruled
     the other way: hybrid is only acceptable if the office is in Arizona, and
     the word Remote sitting beside a city does not rescue it. Vapi and Harvey
     both carried this exact string and both reached the top of his list. */
  ['Hybrid / FullTime / San Francisco / Remote', '', false, 'hybrid in SF is out, whatever else the string says'],
  ['CA Remote (BC & ON only); U.S. Remote', '', true, 'US Remote is offered too'],
  ['Phoenix, Arizona', '', true, 'his own metro, on site is fine'],
  ['Hybrid - Tempe, AZ', '', true, 'hybrid in Arizona is exactly the rule'],
  ['100% remote US (listed Chicago, IL as hub; remote)', '', true, 'remote US with a hub named'],
  ['', 'Senior Product Manager (Remote)', true, 'remote stated in the TITLE only'],

  ['San Francisco, CA', '', false, 'AMPLITUDE: the one that got through'],
  ['Mountain View, California; San Francisco, California', '', false, 'two Bay Area offices'],
  ['New York City, NY; San Francisco, CA', '', false, 'no remote, no Arizona'],
  ['Palo Alto', '', false, 'a bare city name'],
  ['Seattle, Washington', '', false, 'on site elsewhere'],
  ['Charlotte, NC', '', false, 'on site elsewhere'],
  ['London, England', '', false, 'outside the US'],
  ['Full Time / India', '', false, 'outside the US'],
  ['Contractor / Philippines', '', false, 'outside the US'],
  ['Remote (San Francisco, CA)', '', false, 'REMOTE BUT FENCED to the Bay Area'],
  ['Remote (NC)', '', false, 'remote but fenced to one state'],
  ['Remote (Miami, FL)', '', false, 'remote but fenced to Florida'],
  ['Remote (Pleasanton, CA), Full time', '', false, 'remote but fenced to California'],
  ['Remote (primary) - optional SF / Seattle / NYC', '', true, 'HEADWAY: offices are optional, not a fence'],
  ['Remote - remoteType=Remote; locations RTP NC and Seattle WA', '', true, 'CISCO: describing itself, not restricting'],
  ['Remote - primary location is literally Remote New York; alternates San Francisco', '', true, 'ADOBE: alternates, not a fence'],
  ['TELECOMMUTE', '', true, 'ALEDADE: a remote role in one word'],
  ['Remote (unrestricted)', '', true, 'WIZDAA: says so explicitly'],
  ['Remote-Friendly (Travel-Required) | Washington, DC', '', false, 'ANTHROPIC: remote-friendly at a named office is hybrid'],
  ['Toronto, Remote- Canada', '', false, 'STRIPE: remote within Canada'],
  ['Remote only, San Francisco', '', false, 'FELICIS: Wellfound scopes remote to a city this way'],
  ['Remote only, United States', '', true, 'the same form, scoped to the whole US'],
  ['Remote only, Canada, United States', '', true, 'US is in scope'],
  ['Remote only, Vancouver, Toronto, Remote', '', false, 'LATER: Canadian cities only'],
  ['Bengaluru, India', '', false, 'he named this one'],
  ['Bangalore', '', false, 'and this spelling'],
  ['Amsterdam, Netherlands', '', false, 'he named this one'],
  ['Berlin, Germany', '', false, 'he named this one'],
  ['Toronto, Canada', '', false, 'he named this one'],
  ['Full Time / Canada, Denmark, Estonia, France, Ireland', '', false, 'a European-only list'],
  ['Remote USA, Canada', '', true, 'US is included, so it stays'],
  ['Remote - Remote (United States | Canada)', '', true, 'US is included'],
  ['San Francisco, CA, New York, NY, Portland, OR, or Remote', '', true, 'remote offered as an alternative'],
  ['United States', '', true, 'a country with no city cannot be an on-site requirement'],
  ['Full Time / United States', '', true, 'same, as Boulevard words it'],
  ['', '', false, 'no location at all fails closed'],
];

const role = [
  ['Principal Product Manager, AI Agents & MCP', true, 'a product role'],
  ['Staff Product Manager, App Platform & Experience', true, 'a product role'],
  ['Group Product Manager, Compliance', true, 'a product role'],
  ['Director, Product Management', true, 'a product role'],
  ['Head of Product', true, 'a product role'],
  ['Senior Director of Product, Ads Platform', true, 'director OF product is still product'],
  ['AI Digital Product Sr Manager - AI Studio', true, 'an odd word order, still a product role'],
  ['Senior Technical Product Manager, Rules of Road', true, 'technical PM is still PM'],

  ['Senior Engineering Manager, Enterprise AI Product', false, 'THE ONE HE FLAGGED - engineering wins over the word product'],
  ['Engineering Manager, Product Platform', false, 'same shape'],
  ['Senior Software Engineer', false, 'not product'],
  ['Lead Product Manager, Security', false, 'HE ASKED FOR THIS: no security roles'],
  ['Principal Product Manager, Cybersecurity', false, 'nor cybersecurity'],
  ['Staff Product Manager, Trust and Safety', false, 'nor trust and safety'],
  ['Senior Product Manager, Identity and Access Management', false, 'nor IAM'],
  ['Product Manager, Threat Intelligence', false, 'nor threat work'],
  ['Senior Product Manager, AI Platform', true, 'a normal product role is untouched'],
  ['Principal Product Manager, Data and AI Products', true, 'and this one'],
  ['Technical Program Manager, New Product Deployment', false, 'program, not product'],
  ['Data Scientist, Product Analytics', false, 'not product'],
  ['Product Designer', false, 'design, not product management'],
  ['Product Marketing Manager', false, 'marketing, not product management'],
  ['', false, 'no title fails closed'],
];

let bad = 0;
BLOCKS_RUN += 1;
console.log('LOCATION');
for (const [wt, ti, want, why] of loc) {
  const got = locationEligible(wt, ti);
  const ok = got.ok === want;
  if (!ok) bad += 1;
  const label = (wt || '(none)') + (ti ? ' + ' + ti : '');
  console.log((ok ? '  ok   ' : '  FAIL ') + String(got.ok).padEnd(6) + label.slice(0, 46).padEnd(48) + got.why.slice(0, 24).padEnd(26) + why);
}
console.log('ROLE');
for (const [ti, want, why] of role) {
  const got = roleEligible(ti);
  const ok = got.ok === want;
  if (!ok) bad += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + String(got.ok).padEnd(6) + (ti || '(none)').slice(0, 48).padEnd(50) + got.why.slice(0, 22).padEnd(24) + why);
}
const pos = loc.filter(c => c[2]).length + role.filter(c => c[1]).length;
const neg = loc.length + role.length - pos;
if (!pos || !neg) { console.log('FAIL the suite needs both accepted and rejected cases'); bad += 1; }
console.log(String.fromCharCode(10) + (bad ? bad + ' failed' : 'both rules hold in both directions (' + pos + ' accepted, ' + neg + ' rejected)'));
/* the exit moved to the end of the file: an early exit here silently
   skipped every case appended below it */

/* Hybrid rule, given 2026-08-26: hybrid is only acceptable in Arizona. */
{
  BLOCKS_RUN += 1;
  const hybrid = [
    ['Hybrid / FullTime / San Francisco / Remote', false, 'THE ONE HE FLAGGED - Vapi and Harvey'],
    ['Hybrid / FullTime / New York / Remote',      false, 'same shape, different city'],
    ['Hybrid - London',                            false, 'hybrid abroad'],
    ['Hybrid / Phoenix, AZ',                       true,  'hybrid IS fine in Arizona'],
    ['Hybrid / Tempe',                             true,  'and in the Phoenix metro'],
    ['Remote - US',                                true,  'a plain remote role is untouched'],
    ['Remote · US (AZ eligible) or NY office',     true,  'remote with an optional office is still remote'],
  ];
  let bad = 0;
  for (const [text, want, note] of hybrid) {
    const got = locationEligible(text, '');
    const ok = got.ok === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(got.ok).padEnd(5)} ${text.padEnd(42).slice(0,42)} ${got.why.padEnd(38)} ${note}`);
  }
  console.log(bad ? `\n${bad} HYBRID CASES FAILED` : '\nthe hybrid rule holds in both directions');
  if (bad) process.exitCode = 1;
}

/* exit lives at the very end; anything after it never runs */

/* Product operations, wanted by Brian on 2026-08-27, judged on the description. */
{
  BLOCKS_RUN += 1;
  const ops = [
    ['Product Operations Manager',          true,  'the Samsara shape he applied to'],
    ['Senior Manager, Product Operations',  true,  'the words the other way round'],
    ['Product Operations Specialist',       true,  'seniority is the ranker’s job, not the gate’s'],
    ['Director of Product Operations',      true,  ''],
    ['Product Ops Manager',                 true,  'abbreviated'],
    ['Sales Operations Manager',            false, 'operations, but not product'],
    ['Business Operations Manager',         false, 'nor this'],
    ['Marketing Operations Manager',        false, 'nor this'],
    ['Revenue Operations Manager',          false, 'nor this'],
  ];
  let bad = 0;
  for (const [title, want, note] of ops) {
    const got = roleEligible(title);
    const ok = got.ok === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(got.ok).padEnd(5)} ${title.padEnd(36)} ${got.why.padEnd(34)} ${note}`);
  }
  console.log(bad ? `\n${bad} PRODUCT-OPS CASES FAILED` : '\nproduct operations is in, and other operations roles are not');
  if (bad) process.exitCode = 1;
}

/* Product success is customer success, not product management. Teamworks
   "Senior Product Success Manager I (Nutrition, Pro)" sat in the queue
   because IS_PRODUCT's "product ... manager" window matched it. NOT_PRODUCT
   already had "customer success" and is tested first. A PM who owns a
   success PRODUCT still has to pass -- "Senior Product Manager, Success
   Platform" does not contain the phrase "product success". */
{
  BLOCKS_RUN += 1;
  const success = [
    ['Senior Product Success Manager I (Nutrition, Pro)', false, 'THE ONE HE FLAGGED - Teamworks, customer success not product'],
    ['Customer Success Manager',                          false, 'already excluded as customer success'],
    ['Senior Product Manager, Success Platform',          true,  'a PM who owns a success product is still a PM'],
  ];
  let bad = 0;
  for (const [title, want, note] of success) {
    const got = roleEligible(title);
    const ok = got.ok === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(got.ok).padEnd(5)} ${title.padEnd(52)} ${got.why.padEnd(34)} ${note}`);
  }
  console.log(bad ? `\n${bad} PRODUCT-SUCCESS CASES FAILED` : '\nproduct success is out, and a PM who owns a success product is not');
  if (bad) process.exitCode = 1;
}

/* A suite that silently runs less than it contains reports green for cases that
   never executed. Nine product-operations cases were appended after an exit
   that had been moved to the end of the file, and the suite still said it
   passed. Count what actually ran and fail if a block went missing. */
const EXPECTED_BLOCKS = 4;   // location+role, hybrid, product operations, product success
if (BLOCKS_RUN !== EXPECTED_BLOCKS) {
  console.log(`
FAIL only ${BLOCKS_RUN} of ${EXPECTED_BLOCKS} test blocks ran -- the rest never executed`);
  process.exit(1);
}
/* ---------------------------------------- every state, not most of them -- */

/* US_ELSEWHERE is a hand-written list, and a hand-written list of fifty things
   is wrong until something counts them. South Carolina, North Dakota and South
   Dakota were missing, so an on-site posting in any of them fell through to the
   US_WIDE branch and came back "US-wide, no city named" -- with a city and a
   state named right there in the text. No existing case caught it, because
   every one of them happened to name a state that was on the list. */
const STATES = [
  'Alabama', 'Alaska', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana',
  'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
  'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri',
  'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico',
  'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
  'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee',
  'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
  'Wisconsin', 'Wyoming'
];

console.log('EVERY STATE');
const leaked = STATES.filter((state) =>
  locationEligible('Springfield, ' + state + ', United States', 'Product Manager').ok);
if (leaked.length) {
  bad += 1;
  console.log('  FAIL on-site roles in these states are wrongly eligible: ' + leaked.join(', '));
} else {
  console.log('  ok   an on-site role in each of the 49 non-home states is refused (' + STATES.length + ' checked)');
}

/* The other direction, so the fix cannot become "refuse everything". */
for (const [wt, ti, want, label] of [
  ['Phoenix, Arizona, United States', 'Product Manager', true, 'Arizona still wins outright'],
  ['United States', 'Product Manager', true, 'US-wide naming no city is still eligible'],
  ['United States', 'Product Manager (Remote)', true, 'remote is still eligible']
]) {
  const got = locationEligible(wt, ti);
  if (got.ok !== want) { bad += 1; console.log('  FAIL ' + label + ' -> ' + got.why); }
  else console.log('  ok   ' + label);
}

/* ------------------------------- the gate must not refuse what the lens shows -- */

/* Brian, 2026-09-08: an Indeed alert carried "Senior Vice President, Product"
   at Doxim, remote in the United States. The ingest gate refused it with "title
   does not say product management" while "VP of Product" passed, because
   IS_PRODUCT knew the abbreviation and not the spelled-out form.

   index.html has a LEADERSHIP_TITLE pattern and a pill built to display exactly
   these titles. A row the gate refuses can never reach that pill, so the two
   were contradicting each other with no test in between. This reads the real
   pattern out of index.html rather than restating it, because a copy here would
   agree with itself forever while the page changed. */
const pageSrc = fs.readFileSync('index.html', 'utf8');
const leadershipLine = (pageSrc.match(/var LEADERSHIP_TITLE = \/(.+?)\/i;/) || [])[1] || '';
const LEADERSHIP = leadershipLine ? new RegExp(leadershipLine, 'i') : null;

console.log('GATE AGAINST THE LEADERSHIP LENS');
if (!LEADERSHIP) {
  bad += 1;
  console.log('  FAIL could not read LEADERSHIP_TITLE out of index.html');
} else {
  /* Titles the PILL is built to show. Each must survive the ingest gate, or the
     pill is advertising rows that were thrown away before they reached it. */
  const LEADERSHIP_TITLES = [
    'Director of Product',
    'Director, Product Management',
    'Head of Product',
    'VP of Product',
    'VP, Product Management',
    'Vice President of Product',
    'Senior Vice President, Product',
    'SVP, Product',
    'Chief Product Officer'
  ];
  const notLens = LEADERSHIP_TITLES.filter((t) => !LEADERSHIP.test(t));
  if (notLens.length) {
    bad += 1;
    console.log('  FAIL these are not matched by the page lens: ' + notLens.join('; '));
  } else {
    console.log('  ok   every sample title is one the leadership pill would show');
  }
  const refused = LEADERSHIP_TITLES.filter((t) => !roleEligible(t).ok);
  if (refused.length) {
    bad += 1;
    console.log('  FAIL the ingest gate refuses titles the pill exists to show: ' + refused.join('; '));
  } else {
    console.log('  ok   the ingest gate admits all ' + LEADERSHIP_TITLES.length + ' of them');
  }
}

/* The other direction, so widening the gate for leadership did not open it to
   every senior title with the word product anywhere near it. */
for (const [title, want, label] of [
  ['Vice President, Product Marketing', false, 'product marketing stays out'],
  ['Senior Vice President, Sales', false, 'a sales SVP stays out'],
  ['Vice President, Engineering', false, 'an engineering VP stays out'],
  ['SVP, Customer Success', false, 'customer success stays out']
]) {
  const got = roleEligible(title);
  if (got.ok !== want) { bad += 1; console.log('  FAIL ' + label + ' -> ' + got.why); }
  else console.log('  ok   ' + label);
}

console.log(`
all ${EXPECTED_BLOCKS} blocks ran`);
process.exit((bad || process.exitCode) ? 1 : 0);
