/**
 * Remotive and Working Nomads, and the field that decides whether a row is
 * reachable at all.
 *
 * "Remote does not always mean worldwide." Both feeds publish an eligibility
 * string, and it is the only thing separating a role Brian can take from one he
 * cannot. Remotive's own feed today carries "France, Japan, Turkey, Vietnam,
 * Mexico, Norway" on a remote row. If that string does not reach `work_type`,
 * the location gate sees a remote job and lets it through, and the queue fills
 * with roles no US applicant is eligible for.
 *
 * So the cases below are mostly about that one string surviving the mapping.
 *
 * Run: node ingest/test-remote-feeds.mjs
 */

import { normalizeRemotiveJobs } from './sources/remotive.mjs';
import { normalizeWorkingNomadsJobs } from './sources/workingnomads.mjs';
import { locationEligible } from './location-eligible.mjs';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(64)} ${detail ?? ''}`);
};

/* Shapes copied from what the two APIs actually returned on 2026-09-12. */
const REMOTIVE = {
  jobs: [
    {
      id: 2091126,
      url: 'https://remotive.com/remote-jobs/artificial-intelligence/ai-response-evaluator-2091126',
      title: 'AI Response Evaluator',
      company_name: 'iMerit Technology',
      category: 'Artificial Intelligence',
      tags: ['AI/ML', 'research'],
      job_type: 'freelance',
      publication_date: '2026-09-11T06:49:00',
      candidate_required_location: 'France, Japan, Turkey, Vietnam, Mexico, Norway'
    },
    {
      id: 2091127,
      url: 'https://remotive.com/remote-jobs/product/senior-product-manager-2091127',
      title: 'Senior Product Manager',
      company_name: 'Example Co',
      tags: [],
      job_type: 'full_time',
      publication_date: '2026-09-12T10:00:00',
      candidate_required_location: 'USA'
    },
    { id: 3, title: 'No url here', company_name: 'Nope' },
    { id: 4, url: 'https://remotive.com/x', company_name: 'Nope' }
  ]
};

/* The shape the search index returns: Elasticsearch hits with a _source. Copied
   from https://www.workingnomads.com/jobsapi/_search on 2026-09-16. The first
   version of this fixture was the /api/exposed_jobs/ shape, which turned out
   to be the 53 premium rows with zero product managers in them. */
const NOMADS = {
  hits: {
    total: { value: 3 },
    hits: [
      { _source: {
        title: 'Senior Product Manager', company: 'Nearform', category_name: 'Management',
        locations: ['UK'], position_type: 'full-time', apply_url: 'https://job-boards.greenhouse.io/nearform/jobs/7651083003',
        pub_date: '2026-09-16T07:19:03.181135-04:00', salary_range: '£85k per year', annual_salary_usd: 110500, premium: false, expired: false
      } },
      { _source: {
        title: 'Product Manager - Voice AI', company: 'Podium', category_name: 'Management',
        locations: ['USA'], position_type: 'full-time', apply_url: 'https://jobs.lever.co/podium/abc123?utm_source=x',
        pub_date: '2026-09-15T10:00:00-04:00', annual_salary_usd: 0, premium: false, expired: false
      } },
      { _source: {
        title: 'Expired one', company: 'Gone', locations: ['USA'], apply_url: 'https://x.example/1',
        pub_date: '2026-09-10T00:00:00-04:00', expired: true
      } },
      { _source: { title: 'no url', company: 'Nope', locations: ['USA'] } }
    ]
  }
};

/* ------------------------------------------------------------------ remotive -- */

const rem = normalizeRemotiveJobs(REMOTIVE);
check('rows without a title or a url are dropped', rem.length === 2, `${rem.length} kept of 4`);
check('the title and employer come through',
  rem[0].title === 'AI Response Evaluator' && rem[0].company === 'iMerit Technology',
  `${rem[0].company} / ${rem[0].title}`);
check('the source is stamped', rem.every((r) => r.source === 'remotive'));
check('the publication date parses to an ISO instant',
  !Number.isNaN(Date.parse(rem[0].posted)), rem[0].posted);

/* THE ONE THAT MATTERS. */
check('the eligibility string reaches work_type',
  /France, Japan, Turkey/.test(rem[0].work_type), rem[0].work_type);
check('and a US-eligible row carries USA',
  /USA/.test(rem[1].work_type), rem[1].work_type);

/* And it has to actually change the gate's answer, or carrying it is decoration. */
check('the location gate REJECTS the Europe-and-Asia-only row',
  locationEligible(rem[0].work_type, rem[0].title).ok === false, locationEligible(rem[0].work_type, rem[0].title).why);
check('and ACCEPTS the USA row',
  locationEligible(rem[1].work_type, rem[1].title).ok === true, locationEligible(rem[1].work_type, rem[1].title).why);

check('a payload that is not an object yields nothing',
  normalizeRemotiveJobs(null).length === 0 && normalizeRemotiveJobs('nope').length === 0);
check('a bare array is accepted too, not only {jobs}',
  normalizeRemotiveJobs(REMOTIVE.jobs).length === 2);

/* ------------------------------------------------------------ working nomads -- */

const wn = normalizeWorkingNomadsJobs(NOMADS);
check('working nomads keeps the live rows with a url', wn.length === 2, `${wn.length} kept of 4`);
check('an expired row is dropped, not carried', !wn.some((r) => r.company === 'Gone'));
check('its title and employer come through',
  wn[0].title === 'Senior Product Manager' && wn[0].company === 'Nearform',
  `${wn[0].company} / ${wn[0].title}`);
check('its source is stamped', wn.every((r) => r.source === 'workingnomads'));
/* THE ONE THAT MATTERS: the EMPLOYER's url, so decide() can match duplicates
   from Greenhouse and Lever against it. */
check('the stored url is apply_url, the employer posting',
  wn[0].url === 'https://job-boards.greenhouse.io/nearform/jobs/7651083003', wn[0].url);
check('its pub_date parses', !Number.isNaN(Date.parse(wn[0].posted)), wn[0].posted);
check('locations reach work_type', /UK/.test(wn[0].work_type) && /USA/.test(wn[1].work_type),
  `${wn[0].work_type} | ${wn[1].work_type}`);
/* "UK" alone was passing the gate: the country list knew "united kingdom" and
   "london" but not the two-letter form a board prints. */
check('a UK-only row is refused by the gate',
  locationEligible(wn[0].work_type, wn[0].title).ok === false, wn[0].work_type);
check('a USA row is accepted', locationEligible(wn[1].work_type, wn[1].title).ok === true);
check('annual_salary_usd becomes salary_min, and 0 becomes null',
  wn[0].salary_min === 110500 && wn[1].salary_min === null, `${wn[0].salary_min} / ${wn[1].salary_min}`);
check('a bare array of sources is accepted too',
  normalizeWorkingNomadsJobs(NOMADS.hits.hits.map((h) => h._source)).length === 2);
check('a payload with no hits yields nothing',
  normalizeWorkingNomadsJobs(null).length === 0 && normalizeWorkingNomadsJobs({}).length === 0);

console.log(bad
  ? `\n${bad} FAILED`
  : '\nboth feeds map cleanly, and the eligibility string survives far enough to change the gate\'s answer');
process.exitCode = bad ? 1 : 0;
