/**
 * Build the LinkedIn searches Aakash Gupta's method actually calls for.
 *
 * Source: linkedin.com/feed/update/urn:li:activity:7504051227832451072, read
 * 2026-09-11. Its steps are: open the company page, go to People, search by the
 * function the role sits in, and find the two or three people who have posted
 * about that team, product or opening in the past month. If nobody has posted,
 * look at the recruiter's connections inside the company. Message BEFORE
 * applying.
 *
 * NO NAMES ARE INVENTED HERE. Every link is a SEARCH built from the company
 * name already stored on the row, and LinkedIn answers it with whoever is
 * actually there. A page listing "the hiring manager is X" would be a
 * fabrication dressed as research, which is the one thing this must not be.
 *
 * Keyword search rather than a /company/<slug>/people/ URL on purpose: a slug
 * has to be guessed from the company name, and a wrong guess is a 404 that
 * looks like "this company has nobody".
 */

/** LinkedIn's people search. Quoting the company keeps a two-word name together. */
const PEOPLE = 'https://www.linkedin.com/search/results/people/?keywords=';
/** Posts, which is how the method finds who is talking about the team. */
const POSTS = 'https://www.linkedin.com/search/results/content/?keywords=';
/** The company's own page, the method's step one. */
const COMPANIES = 'https://www.linkedin.com/search/results/companies/?keywords=';

/**
 * Titles worth searching for a product role, most senior last.
 *
 * A hiring manager for a PM opening is usually one rung up. Recruiters are in
 * the list because the method falls back to their connections when nobody on
 * the team has posted.
 */
export const ROLE_TERMS = [
  'head of product',
  'director product',
  'vp product',
  'group product manager',
  'technical recruiter'
];

/**
 * Strip the decorations a job board adds to an employer name.
 *
 * "Jobgether (anonymized)" and "OMG Technologies / Advance Auto Parts (client)"
 * both search badly as written. The first bracketed or slashed segment is the
 * employer; the rest is the board talking.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanCompany(raw) {
  return String(raw || '')
    .split('/')[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|plc|gmbh|holdings|group)\b\.?/gi, ' ')
    .replace(/[.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A quoted phrase, so a two-word employer is not treated as two terms.
 *
 * @param {string} value
 * @returns {string}
 */
function phrase(value) {
  return `"${value}"`;
}

/**
 * The searches for one posting, in the order the method performs them.
 *
 * @param {{ company: string, title: string }} row
 * @returns {Array<{ step: number, label: string, url: string, why: string }>}
 */
export function searchesFor(row) {
  const company = cleanCompany(row && row.company);
  if (!company) return [];
  const q = (terms) => encodeURIComponent(terms.join(' '));

  return [
    {
      step: 1,
      label: 'Company page',
      url: COMPANIES + q([phrase(company)]),
      why: 'Step one of the method. Open the company, then its People tab.'
    },
    {
      step: 2,
      label: 'Product leaders there',
      url: PEOPLE + q([phrase(company), ROLE_TERMS.slice(0, 3).join(' OR ')]),
      /* One rung up from the opening is who owns the req. */
      why: 'Head of Product, Director and VP at this employer. The manager for a PM opening is usually one rung above it.'
    },
    {
      step: 3,
      label: 'Who has posted about the team',
      url: POSTS + q([phrase(company), 'hiring OR "we are looking" OR "join our team" OR roadmap']),
      why: 'The method looks for the two or three people who posted about the team, product or opening in the past month. Filter to Past month once the results load.'
    },
    {
      step: 4,
      label: 'Recruiters there',
      url: PEOPLE + q([phrase(company), 'recruiter OR "talent acquisition"']),
      why: 'The fallback when nobody on the team has posted: work through a recruiter\'s connections inside the company.'
    }
  ];
}

/**
 * The three message shapes the post says get replies, with his own material
 * filled in where the shape allows it.
 *
 * Each one has to end in a question answerable in a single sentence. That is
 * the post's own constraint and it is the part most easily lost when a template
 * gets personalised.
 *
 * @param {{ company: string, title: string }} row
 * @returns {Array<{ name: string, body: string, note: string }>}
 */
export function messageShapes(row) {
  const company = cleanCompany(row && row.company) || 'your team';
  const title = String((row && row.title) || 'the role').trim();

  return [
    {
      name: 'Work product',
      body: `I built something against ${company} before writing to you. `
        + `[One sentence on what you looked at and the one opportunity you found.] `
        + `Is that something ${company} is already working on?`,
      note: 'The strongest of the three, and the most work. It has to be about THEIR product, not a portfolio link. '
        + 'You have the machinery for this: point an agent at their public feedback, docs or changelog and read the output yourself before sending.'
    },
    {
      name: 'Relatability',
      body: `Reaching out because [the genuine thing you share]. I saw the ${title} opening. `
        + `Is the team closer to zero-to-one or to scaling something that already works?`,
      note: 'Only works if the common ground is real. An invented one reads worse than no message at all.'
    },
    {
      name: 'Free offering',
      body: `I have been building AI product tooling and would happily spend 20 minutes `
        + `walking your team through what has worked. No strings. Would that be useful to you this month?`,
      note: 'Give something specific enough to accept. "Pick your brain" asks THEM for the favour.'
    }
  ];
}
