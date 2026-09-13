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

const NOMADS = [
  {
    url: 'https://www.workingnomads.com/job/go/1857010/',
    title: 'Product Lead (Strategy + Full Stack)',
    company_name: 'Optimizee Group',
    category_name: 'Development',
    tags: 'full stack,php,laravel,product owner',
    location: 'Worldwide',
    pub_date: '2026-09-12T08:13:43-04:00'
  },
  {
    url: 'https://www.workingnomads.com/job/go/2/',
    title: 'Product Manager, Europe only',
    company_name: 'Somewhere',
    location: 'Europe',
    pub_date: '2026-09-10T00:00:00-04:00'
  },
  { title: 'no url', company_name: 'Nope' }
];

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
check('working nomads drops the row with no url', wn.length === 2, `${wn.length} kept of 3`);
check('its title and employer come through',
  wn[0].title === 'Product Lead (Strategy + Full Stack)' && wn[0].company === 'Optimizee Group',
  `${wn[0].company} / ${wn[0].title}`);
check('its source is stamped', wn.every((r) => r.source === 'workingnomads'));
check('its pub_date parses', !Number.isNaN(Date.parse(wn[0].posted)), wn[0].posted);
check('its location reaches work_type', /Worldwide/.test(wn[0].work_type), wn[0].work_type);
check('a Europe-only row is refused by the gate',
  locationEligible(wn[1].work_type, wn[1].title).ok === false, wn[1].work_type);
check('a results-wrapped payload is accepted',
  normalizeWorkingNomadsJobs({ results: NOMADS }).length === 2);
check('a payload that is not an array yields nothing',
  normalizeWorkingNomadsJobs(null).length === 0 && normalizeWorkingNomadsJobs({}).length === 0);

console.log(bad
  ? `\n${bad} FAILED`
  : '\nboth feeds map cleanly, and the eligibility string survives far enough to change the gate\'s answer');
process.exitCode = bad ? 1 : 0;
