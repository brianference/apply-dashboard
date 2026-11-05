/**
 * Amazon in the daily run, and the two location changes that came with it.
 *
 * The call sites are tested as well as the rule, through decide() and scoreOne(),
 * because a company argument the callers never pass would leave the exception
 * green here and dead in production.
 *
 * Run: node ingest/test-amazon-and-openai.mjs
 */

import { normalizeAmazonJobs, fetchJobs } from './sources/amazon.mjs';
import { locationEligible } from './location-eligible.mjs';
import { scoreOne } from './fit-score.mjs';
import { decide } from './sync-to-d1.mjs';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(64)} ${detail ?? ''}`);
};

const place = (normalizedLocation) => JSON.stringify({ normalizedLocation, type: 'ONSITE' });
/* Shape copied from what amazon.jobs returned on 2026-11-05. */
const row = (title, job_path, places, company_name = 'Amazon.com Services LLC') => ({
  title, job_path, company_name, posted_date: 'November  5, 2026',
  normalized_location: places[places.length - 1], location: 'US, XX, Somewhere', locations: places.map(place)
});
const PAGE = { hits: 3, jobs: [
  row('Senior Product Manager - Tech, Selling Partner Services', '/en/jobs/1/a', ['Tempe, Arizona, USA']),
  row('Senior Product Manager, Commerce', '/en/jobs/2/b', ['Tempe, Arizona, USA', 'Seattle, Washington, USA']),
  row('Sr. Product Manager - Technical, Leo Futures', '/en/jobs/3/c', ['Redmond, Washington, USA'], 'Amazon Kuiper Commercial Services LLC')
] };

const jobs = normalizeAmazonJobs(PAGE);
check('a posting keeps its url, title and date', jobs[0].url === 'https://www.amazon.jobs/en/jobs/1/a' && jobs[0].posted?.startsWith('2026-11-05'), jobs[0].posted);
check('a legal entity folds to Amazon', jobs[2].company === 'Amazon', jobs[2].company);
check('every location reaches work_type', /Tempe/.test(jobs[1].work_type) && /Seattle/.test(jobs[1].work_type), jobs[1].work_type);
check('Tempe alone passes the gate', locationEligible(jobs[0].work_type, jobs[0].title, 'Amazon').ok);
check('Tempe among other offices passes the gate', locationEligible(jobs[1].work_type, jobs[1].title, 'Amazon').ok);
check('Redmond is refused', !locationEligible(jobs[2].work_type, jobs[2].title, 'Amazon').ok);
check('a malformed location entry does not lose the row', normalizeAmazonJobs({ jobs: [{ title: 'Product Manager', job_path: '/en/jobs/4/d', locations: ['{oops'], normalized_location: 'Tempe, Arizona, USA' }] })[0]?.work_type === 'Tempe, Arizona, USA');

const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify(calls === 1 ? PAGE : { jobs: [] }), { status: 200 }); };
try {
  const fetched = await fetchJobs({ query: 'product' });
  check('paging stops at the first empty page', calls === 2 && fetched.length === 3, `calls ${calls}, rows ${fetched.length}`);
} finally {
  globalThis.fetch = realFetch;
}

const REFUSED = [
  ['Seattle, Washington, USA', 'Principal Product Manager - Tech, AWS Distributed SQL', 'a product called Distributed'],
  ['Santa Clara, California, USA', 'Sr. Product Manager, Virtual Private Cloud, VPC', 'a product called Virtual']
];
for (const [where, title, note] of REFUSED) check(`refused: ${note}`, !locationEligible(where, title).ok, locationEligible(where, title).why);
check('a title can still say remote', locationEligible('United States', 'Senior Product Manager (Remote)').ok);
check('a location can still say virtual', locationEligible('Virtual, USA', 'Senior Product Manager').ok);

const OPENAI = 'Hybrid / FullTime / San Francisco / Remote';
check('OpenAI PM, hybrid and remote: passes', locationEligible(OPENAI, 'Product Manager, Core Models', 'OpenAI').ok);
check('another employer, same words: refused', !locationEligible(OPENAI, 'Product Manager, Core Models', 'Harvey').ok);
check('no company given: refused', !locationEligible(OPENAI, 'Product Manager, Core Models').ok);
check('OpenAI, not a PM title: refused', !locationEligible(OPENAI, 'Product Cost Management Lead', 'OpenAI').ok);
check('OpenAI PM, hybrid only: refused', !locationEligible('Hybrid / FullTime / San Francisco', 'Product Manager, Core Models', 'OpenAI').ok);
check('OpenAI PM, hybrid in Tokyo: refused', !locationEligible('Hybrid / FullTime / Tokyo, Japan / Remote', 'Product Manager, Core Models', 'OpenAI').ok);

const candidate = { company: 'OpenAI', title: 'Product Manager, Enterprise Identity', url: 'https://jobs.ashbyhq.com/openai/x', work_type: OPENAI, source: 'ashby' };
check('decide() passes the company', decide([candidate], []).fresh.length === 1);
check('decide() still refuses the same row elsewhere', decide([{ ...candidate, company: 'Harvey', url: 'https://jobs.ashbyhq.com/harvey/x' }], []).rejected.location === 1);
const reasons = (company) => scoreOne({ ...candidate, company, status: 'queued' }, 'Product manager role.', []).gate.reasons.filter((r) => r.startsWith('location'));
check('scoreOne() passes the company', reasons('OpenAI').length === 0, reasons('OpenAI').join(';'));
check('scoreOne() still refuses the same row elsewhere', reasons('Harvey').length === 1);

console.log(bad ? `\n${bad} failed` : '\nall passed');
process.exit(bad ? 1 : 0);
