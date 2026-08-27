/**
 * Board-token resolver, tested against fixtures. No network.
 *
 * The suite covers both directions: a title that is on the board resolves, a
 * board that exists but lacks the title does not, two equal titles are
 * ambiguous, a 404 never produces a URL even when its body looks like a hit,
 * and Sr. matches Senior. The last block feeds the matcher inputs that MUST
 * fail — a check whose bad input still passes is not a check.
 *
 *   node ingest/test-resolve-by-board.mjs
 */

import {
  boardTokens,
  matchPostings,
  normalizeTitle,
  parseBoardPostings,
  resolveJob,
  salaryFromPosting
} from './resolve-by-board.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
const check = (name, ok, detail) => {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(62)} ${detail || ''}`);
};

const GH = 'https://job-boards.greenhouse.io/boulevard/jobs/1';
const GH_OTHER = 'https://job-boards.greenhouse.io/boulevard/jobs/2';
const FAKE_FROM_404 = 'https://job-boards.greenhouse.io/notreal/jobs/999';
const BODY_HREF = 'https://boards.greenhouse.io/orderlynetwork/jobs/404404';

/**
 * @param {Record<string, {status: number, json: unknown}>} boards
 * @returns {(ats: string, token: string) => Promise<{status: number|null, json: unknown, error: string|null}>}
 */
function fakeFetch(boards) {
  return async (ats, token) => {
    const hit = boards[`${ats}::${token}`];
    if (!hit) return { status: 404, json: null, error: 'board returned 404' };
    return { status: hit.status, json: hit.json, error: hit.status === 200 ? null : `board returned ${hit.status}` };
  };
}

const companies = {
  greenhouse: [{ token: 'boulevard', name: 'Boulevard' }],
  lever: [{ token: 'pointb', name: 'Point B' }],
  ashby: []
};

/* ---- tokens ------------------------------------------------------- */

const zebra = boardTokens('The Zebra', companies).map((c) => c.token);
check('drop a leading "the"', zebra.includes('zebra'), zebra.join(','));

const pointb = boardTokens('Point B', companies);
check('Point B guesses pointb and point-b',
  pointb.some((c) => c.token === 'pointb') && pointb.some((c) => c.token === 'point-b'),
  pointb.map((c) => c.token).join(','));
check('Point B prefers lever/pointb from companies.json',
  pointb[0].token === 'pointb' && pointb[0].preferredAts.includes('lever'),
  JSON.stringify(pointb[0]));

const arpio = boardTokens('Arpio Inc', {}).map((c) => c.token);
check('corporate suffix stripped', arpio.includes('arpio'), arpio.join(','));

const boulevard = boardTokens('Boulevard', companies);
check('companies.json name match is first',
  boulevard[0].token === 'boulevard' && boulevard[0].source === 'companies.json'
  && boulevard[0].preferredAts.includes('greenhouse'));

/* ---- title normalisation ------------------------------------------ */

check('Sr. Product Manager matches Senior Product Manager',
  normalizeTitle('Sr. Product Manager') === normalizeTitle('Senior Product Manager'),
  `"${normalizeTitle('Sr. Product Manager')}"`);
check('& becomes and',
  normalizeTitle('PM, App Platform & Experience') === normalizeTitle('PM, App Platform and Experience'));

/* ---- resolve: the good cases -------------------------------------- */

const exact = await resolveJob(
  { company: 'Boulevard', title: 'Senior Product Manager', url: 'https://himalayas.app/x', dedupe_key: 'boulevard|senior product manager' },
  {
    companies,
    fetchBoard: fakeFetch({
      'greenhouse::boulevard': {
        status: 200,
        json: { jobs: [{ id: 1, title: 'Senior Product Manager', absolute_url: GH }] }
      }
    }),
    fetchPostingDetail: async () => ({ status: 404, json: null, error: 'skipped' })
  }
);
check('exact title on a 200 board resolves',
  exact.url === GH && exact.ats === 'greenhouse' && exact.reason === null,
  `${exact.ats} ${exact.url}`);

const sr = await resolveJob(
  { company: 'Boulevard', title: 'Sr. Product Manager', url: 'https://himalayas.app/x' },
  {
    companies,
    fetchBoard: fakeFetch({
      'greenhouse::boulevard': {
        status: 200,
        json: { jobs: [{ id: 1, title: 'Senior Product Manager', absolute_url: GH }] }
      }
    }),
    fetchPostingDetail: async () => ({ status: 404, json: null, error: 'skipped' })
  }
);
check('Sr. Product Manager matches Senior Product Manager on the board',
  sr.url === GH && sr.reason === null,
  sr.url);

const missing = await resolveJob(
  { company: 'Boulevard', title: 'Principal Product Manager, AI', url: 'https://himalayas.app/x' },
  {
    companies,
    fetchBoard: fakeFetch({
      'greenhouse::boulevard': {
        status: 200,
        json: { jobs: [{ id: 1, title: 'Senior Product Manager', absolute_url: GH }] }
      }
    })
  }
);
check('board exists but lacks the title -> no-title-match',
  missing.reason === 'no-title-match' && missing.url === null && missing.http_status === 200,
  missing.error);

const ambiguous = await resolveJob(
  { company: 'Boulevard', title: 'Senior Product Manager', url: 'https://himalayas.app/x' },
  {
    companies,
    fetchBoard: fakeFetch({
      'greenhouse::boulevard': {
        status: 200,
        json: {
          jobs: [
            { id: 1, title: 'Senior Product Manager', absolute_url: GH },
            { id: 2, title: 'Sr. Product Manager', absolute_url: GH_OTHER }
          ]
        }
      }
    })
  }
);
check('two equally-matching titles -> ambiguous, resolve nothing',
  ambiguous.reason === 'ambiguous' && ambiguous.url === null && ambiguous.http_status === 200,
  ambiguous.error);

const notFound = await resolveJob(
  { company: 'Definitely Not A Real Company XYZ', title: 'Senior Product Manager', url: 'https://himalayas.app/x' },
  {
    companies: { greenhouse: [], lever: [], ashby: [] },
    fetchBoard: async () => ({
      status: 404,
      json: { jobs: [{ title: 'Senior Product Manager', absolute_url: FAKE_FROM_404 }] },
      error: 'board returned 404'
    })
  }
);
check('a 404 token never produces a URL',
  notFound.url === null && notFound.reason === 'no-board' && notFound.http_status === 404,
  `${notFound.reason} ${notFound.url}`);

const emptyThenReal = await resolveJob(
  { company: 'Lynx Software Technologies', title: 'Senior Product Manager', url: 'https://himalayas.app/x' },
  {
    companies: { greenhouse: [], lever: [], ashby: [] },
    fetchBoard: fakeFetch({
      'workable::lynx-software-technologies': { status: 200, json: { jobs: [] } },
      'smartrecruiters::lynx-software-technologies': { status: 200, json: { content: [], totalFound: 0 } },
      'greenhouse::lynx': {
        status: 200,
        json: { jobs: [{ id: 1, title: 'Senior Product Manager', absolute_url: GH }] }
      }
    }),
    fetchPostingDetail: async () => ({ status: 404, json: null, error: 'skipped' })
  }
);
check('empty 200 on workable/SR does not block a later greenhouse token',
  emptyThenReal.url === GH && emptyThenReal.token === 'lynx' && emptyThenReal.ats === 'greenhouse',
  `${emptyThenReal.ats}/${emptyThenReal.token} ${emptyThenReal.url}`);

const onlyEmpty = await resolveJob(
  { company: 'No Such Board', title: 'Senior Product Manager', url: 'https://himalayas.app/x' },
  {
    companies: { greenhouse: [], lever: [], ashby: [] },
    fetchBoard: async (ats) => {
      if (ats === 'workable') return { status: 200, json: { jobs: [] }, error: null };
      if (ats === 'smartrecruiters') return { status: 200, json: { content: [], totalFound: 0 }, error: null };
      return { status: 404, json: null, error: 'board returned 404' };
    }
  }
);
check('empty 200s alone are no-board, not a resolution',
  onlyEmpty.url === null && onlyEmpty.reason === 'no-board',
  onlyEmpty.error);

/* ---- salary stays on THIS posting --------------------------------- */

const paid = salaryFromPosting({
  salaryText: 'The base salary range is $185,000 - $260,000 per year.',
  structuredSalary: null
});
check('salary comes from the matched posting band',
  paid.min === 185000 && paid.max === 260000 && paid.source === 'posting',
  `${paid.min}-${paid.max}`);

const siblingPay = salaryFromPosting({
  salaryText: 'Other job $75,000 Apply now. Another listing $228,000.',
  structuredSalary: null
});
check('scattered figures on the same page are not a band',
  siblingPay.min === null && siblingPay.source === null,
  JSON.stringify(siblingPay));

/* ---- known-bad block: these MUST fail ----------------------------- */

check('Senior Product Manager does NOT match Senior Product Manager, Platform',
  matchPostings('Senior Product Manager', [{ title: 'Senior Product Manager, Platform' }]).length === 0);

check('Product Manager does NOT match Senior Product Manager',
  matchPostings('Product Manager', [{ title: 'Senior Product Manager' }]).length === 0);

check('Senior Product Manager does NOT match Senior Products Manager',
  matchPostings('Senior Product Manager', [{ title: 'Senior Products Manager' }]).length === 0);

check('empty title matches nothing',
  matchPostings('', [{ title: 'Senior Product Manager' }]).length === 0
  && matchPostings('Senior Product Manager', [{ title: '' }]).length === 0);

const from404 = parseBoardPostings('greenhouse', {
  jobs: [{ title: 'Senior Product Manager', absolute_url: FAKE_FROM_404 }]
});
check('parseBoardPostings is never the source of a 404 URL in resolveJob',
  notFound.url !== FAKE_FROM_404 && notFound.url == null,
  `resolved url=${notFound.url}; fixture url exists in parser=${from404[0].url}`);

const bodyLink = await resolveJob(
  { company: 'Boulevard', title: 'Senior Product Manager', url: 'https://himalayas.app/x' },
  {
    companies,
    fetchBoard: fakeFetch({
      'greenhouse::boulevard': {
        status: 200,
        json: {
          jobs: [{
            id: 1,
            title: 'Senior Product Manager',
            absolute_url: null,
            content: `<p>Apply at <a href="${BODY_HREF}">greenhouse</a></p>`
          }]
        }
      }
    }),
    fetchPostingDetail: async () => ({
      status: 200,
      json: { content: `<p>Apply at <a href="${BODY_HREF}">greenhouse</a></p>`, absolute_url: null },
      error: null
    })
  }
);
check('a description-body href is not an apply URL',
  bodyLink.url === null && bodyLink.reason === 'no-url-on-posting',
  bodyLink.error);

const stolenSalary = await resolveJob(
  { company: 'Boulevard', title: 'Senior Product Manager', url: 'https://himalayas.app/x' },
  {
    companies,
    fetchBoard: fakeFetch({
      'greenhouse::boulevard': {
        status: 200,
        json: {
          jobs: [
            { id: 1, title: 'Senior Product Manager', absolute_url: GH },
            { id: 2, title: 'Staff Engineer', absolute_url: GH_OTHER }
          ]
        }
      }
    }),
    fetchPostingDetail: async (_ats, _token, posting) => {
      if (posting.id === '2') {
        return { status: 200, json: { content: 'Salary $200,000 - $250,000', absolute_url: GH_OTHER }, error: null };
      }
      return { status: 200, json: { content: 'No pay published.', absolute_url: GH }, error: null };
    }
  }
);
check('salary is not carried over from a sibling posting',
  stolenSalary.url === GH && stolenSalary.salary_min === null && stolenSalary.salary_source === null,
  `min=${stolenSalary.salary_min} source=${stolenSalary.salary_source}`);

/* The retired scrape-the-aggregator mechanism would have treated a
   description-body greenhouse link as a resolution. If THAT still passes
   the suite, the suite is decorative. */
check('the Orderly-Network shape (body href, no board URL) FAILS closed',
  bodyLink.url !== BODY_HREF && bodyLink.url == null);

console.log(bad ? `\n${bad} FAILED` : '\nevery case behaves as intended, including the ones built to fail');
process.exitCode = bad ? 1 : 0;
