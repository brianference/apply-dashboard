/**
 * Outreach: the highest-ranked open postings, with the searches that find who
 * to message about each one.
 *
 * Brian, 2026-09-11: a separate page with links to hiring managers I can
 * message for top rated new jobs, pointing at
 * linkedin.com/feed/update/urn:li:activity:7504051227832451072.
 *
 * The post's method is five minutes of LinkedIn per company: open the company,
 * go to People, search the function, find who posted about the team this month,
 * and message BEFORE applying. This page does the part a page can do, which is
 * to put the right searches one click away for the rows worth the five minutes.
 *
 * What it deliberately does NOT do is name a person. Nothing in this database
 * knows who the hiring manager is, and a page that printed a name would be
 * inventing one. Every link here is a search; LinkedIn answers it with whoever
 * is really there.
 */

import { searchesFor, messageShapes, cleanCompany, namedSearch } from './search-urls.js';
import { addressFor } from './email-pattern.js';

const API = '/api/jobs';
/** Enough to work through in a sitting. The method costs five minutes each. */
const SHOW = 25;
/**
 * "New" for this page. Brian, 2026-09-11: "nothing posted more than a week ago".
 *
 * A row with NO posted date is not old, it is unmeasured, so it cannot be
 * dropped by a rule about age. 68 of 110 rows in this window have no date the
 * board ever published. They go in their own group instead of being silently
 * mixed into the fresh list or silently discarded.
 */
const FRESH_DAYS = 7;

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const at = (id) => document.querySelector(id);

/**
 * Days since publication, or null when the board publishes no date.
 *
 * @param {{ posted: string|null }} row
 * @returns {number|null}
 */
function ageDays(row) {
  if (!row || !row.posted) return null;
  const then = new Date(row.posted).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

/**
 * Escape for interpolation into HTML.
 *
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * An href safe to put in the document, or "#".
 *
 * Every URL on this page comes from either a search I build or the `url`
 * column, and that column is filled by ingest from whatever a job board
 * served. Escaping the quotes stops the attribute breaking out; it does not
 * stop `javascript:`. Only http and https are allowed through.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function safeHref(raw) {
  const value = String(raw == null ? '' : raw).trim();
  try {
    const parsed = new URL(value, location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '#';
  } catch {
    return '#';
  }
}

/**
 * Published band, or an honest blank.
 *
 * @param {{ salary_min: number|null, salary_max: number|null }} row
 * @returns {string}
 */
function payLabel(row) {
  const k = (n) => '$' + Math.round(n / 1000) + 'k';
  if (row.salary_min && row.salary_max) return `${k(row.salary_min)}-${k(row.salary_max)}`;
  if (row.salary_min) return `${k(row.salary_min)}+`;
  /* Not "competitive", not a guess. The employer published nothing. */
  return 'no band published';
}

/**
 * The rows worth the five minutes: open, ranked, and recently posted.
 *
 * Sorted by rank because he asked for top rated. A row with no rank is left
 * out rather than sorted as zero: unranked means unjudged, not judged badly.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<Record<string, any>>}
 */
export function pickTargets(rows) {
  const usable = (rows || []).filter((r) => r && r.url && r.rank_pct != null);
  const byRank = (a, b) => (b.rank_pct || 0) - (a.rank_pct || 0);

  /* Three groups, one predicate each, and no row in two of them.
     - applied: he asked for these by name. A submitted application is a reason
       to message someone, not a reason to stop, and it must not depend on
       surviving a rank slice against 25 unapplied rows.
     - fresh: his window, on rows that actually carry a date.
     - undated: no date was ever published, so the age rule cannot reach them.
       Separate rather than hidden: dropping them would be losing rows for
       missing data and calling it freshness. */
  /* "those high ranked ones which i marked i applied for" -- 80 submitted rows
     would make a 130-card page, so this takes the same top slice as the others. */
  /* The top slice by rank, PLUS any row with researched named people.
     A researched card is the actionable one: it is the difference between four
     searches and a person to write to. Arity at 45% was being cut while every
     row above 54% showed only searches. The union is re-sorted, so each group
     still reads highest first. */
  const withContacts = (r) => !!contactsFor(r.company);
  const slice = (list) => {
    const ranked = list.sort(byRank);
    const top = ranked.slice(0, SHOW);
    const kept = new Set(top);
    const promoted = ranked.filter((r) => !kept.has(r) && withContacts(r));
    return top.concat(promoted).sort(byRank);
  };

  const applied = slice(usable.filter((r) => r.status === 'submitted'));
  const queued = usable.filter((r) => r.status === 'queued');
  const fresh = slice(queued.filter((r) => {
    const a = ageDays(r);
    return a !== null && a <= FRESH_DAYS;
  }));
  const undated = slice(queued.filter((r) => ageDays(r) === null));

  return { fresh, applied, undated };
}

/** Researched people, keyed by employer. Empty until the file loads. */
let CONTACTS = {};

/**
 * Look up researched people for an employer.
 *
 * Matched on the cleaned name, case-insensitively, because the board writes
 * "Jerry.ai" where the company calls itself "Jerry" and the research is filed
 * under one of them.
 *
 * @param {string} raw
 * @returns {{ sources: string[], people: Array<Record<string, any>> }|null}
 */
export function contactsFor(raw) {
  const want = cleanCompany(raw).toLowerCase();
  if (!want) return null;
  for (const [key, value] of Object.entries(CONTACTS)) {
    const have = cleanCompany(key).toLowerCase();
    if (have === want || have.startsWith(want) || want.startsWith(have)) return value;
  }
  return null;
}

/**
 * The address this employer's convention implies for one person.
 *
 * DERIVED, NOT VERIFIED, and the page says so. The shape came from unique
 * addresses in the employer's own public commit metadata, the count is shown,
 * and the address itself is built here in the browser so that no individual
 * address is ever written into this public repository.
 *
 * A name with a particle or a middle token is flagged, because which token is
 * the family name is then a convention rather than a fact.
 *
 * @param {{ email?: Record<string, any> }} company
 * @param {{ name: string }} person
 * @returns {string}
 */
function addressHtml(company, person) {
  const rule = company && company.email;
  if (!rule || !rule.shape) return '';
  const built = addressFor(rule.shape, person.name, rule.domain);
  if (!built) return '';
  const caveat = built.ambiguous
    ? ' The surname was taken as the last word of the name, which a particle makes a guess.'
    : '';
  return `
              <span class="mail">
                <code>${esc(built.address)}</code>
                <button type="button" class="copy mail-copy" data-msg="${esc(built.address)}">Copy address</button>
                <span class="mail-why" title="${esc(`derived from ${rule.shape}, ${rule.pct}% of ${rule.unique}. ${rule.evidence}${caveat}`)}">derived</span>
              </span>`;
}

/**
 * The named-people block for one card, or an empty string.
 *
 * Every person carries the source the name was read on, because a name with no
 * source is indistinguishable from one I made up. Where the person published
 * their own profile URL somewhere public, that link is used and labelled;
 * otherwise the link is a search scoped to their name and employer. A slug is
 * never guessed.
 *
 * @param {Record<string, any>} row
 * @returns {string}
 */
function contactsHtml(row) {
  const found = contactsFor(row.company);
  if (!found || !Array.isArray(found.people) || !found.people.length) return '';

  const rows = found.people.map((p) => {
    const published = p.profile ? safeHref(p.profile) : '';
    const href = published && published !== '#' ? published : safeHref(namedSearch(p.name, row.company));
    const kind = published && published !== '#'
      ? '<span class="tag pub">profile they published</span>'
      : '<span class="tag">name search</span>';
    /* The source is a column, not a hover. A name whose provenance needs a
       mouse to see is a name most readers will take on trust. */
    const src = p.source
      ? `<a class="src" href="${esc(safeHref(p.source))}" target="_blank" rel="noopener noreferrer">source</a>`
      : '<span class="src none">no source</span>';
    return `
              <tr data-person>
                <th scope="row">
                  <a class="person" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a>
                  ${kind}
                  ${p.note ? `<details class="pnote"><summary>why this person</summary><p>${esc(p.note)}</p></details>` : ''}
                </th>
                <td class="role">${esc(p.title || 'title not stated')}</td>
                <td class="tagcell">${p.why ? `<span class="tag why">${esc(p.why)}</span>` : ''}</td>
                <td class="srccell">${src}</td>
                <td class="mailcell">${addressHtml(found, p)}</td>
              </tr>`;
  }).join('');

  const convention = found.email && found.email.shape
    ? `Addresses are built from this employer's own convention and are <strong>not verified</strong>: ${esc(found.email.evidence)}.`
    : 'No address convention could be established for this employer from public evidence, so none is shown.';

  return `
      <div class="contacts">
        <p class="contacts-lede">${found.people.length} named, each with the source the name was read on. ${convention}</p>
        <div class="rosterwrap">
          <table class="people roster">
            <colgroup>
              <col class="c-name"/><col class="c-title"/><col class="c-why"/><col class="c-src"/><col class="c-mail"/>
            </colgroup>
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Title</th><th scope="col">Why</th><th scope="col">Source</th><th scope="col">Address</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
}

/**
 * One posting, its searches and the three message shapes.
 *
 * @param {Record<string, any>} row
 * @param {number} index
 * @returns {string}
 */
function cardHtml(row, index) {
  const company = cleanCompany(row.company) || row.company;
  const age = ageDays(row);
  const found = searchesFor(row);
  /* Chips, in the method's order. The reason for each one is real but it is the
     same four reasons on every card, so it moves into one expander below rather
     than repeating beside all four. Kept in the DOM, not hover-only: a tooltip
     is unreachable from a keyboard. */
  const steps = found.map((s) => `
      <li>
        <a class="step" href="${esc(safeHref(s.url))}" target="_blank" rel="noopener noreferrer">
          <span class="n">${s.step}</span>${esc(s.label)}
        </a>
      </li>`).join('');
  const reasons = found.map((s) => `
        <li><span class="rn">${s.step}</span><span class="why">${esc(s.why)}</span></li>`).join('');

  const shapes = messageShapes(row).map((m) => `
      <details>
        <summary>${esc(m.name)}</summary>
        <p class="msg" data-copy>${esc(m.body)}</p>
        <p class="note">${esc(m.note)}</p>
        <button type="button" class="copy" data-msg="${esc(m.body)}">Copy</button>
      </details>`).join('');

  return `
    <article class="target">
      <header>
        <span class="rank">${esc(row.rank_pct)}%</span>
        <div class="who">
          <h3>${esc(row.title)}</h3>
          <p class="co">${esc(company)}
            <span class="meta">${esc(payLabel(row))}</span>
            <span class="meta">${age === null ? 'no posted date' : age + 'd ago'}</span>
            ${row.status === 'submitted' ? '<span class="meta applied">applied</span>' : ''}
          </p>
        </div>
        <a class="posting" href="${esc(safeHref(row.url))}" target="_blank" rel="noopener noreferrer">The posting</a>
      </header>
      <ol class="steps">${steps}</ol>
      <details class="reasons">
        <summary>What these four searches are for</summary>
        <ol class="reasonlist">${reasons}</ol>
      </details>
      ${contactsHtml(row)}
      <div class="shapes">
        <p class="shapes-lede">Message before you apply. Each one ends in a question answerable in a sentence.</p>
        ${shapes}
      </div>
    </article>`;
}

/** Wire copy buttons once, on the container. */
function wireCopy() {
  at('#targets').addEventListener('click', async (event) => {
    const button = event.target.closest('button.copy');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.getAttribute('data-msg') || '');
      button.textContent = 'Copied';
      /* Say it worked, then go back. A button that stays "Copied" reads as
         broken the second time. */
      setTimeout(() => { button.textContent = 'Copy'; }, 1600);
    } catch {
      button.textContent = 'Select it and copy';
    }
  });
}

async function main() {
  const { mountSiteNav } = await import('/shared/site-nav.js');
  await mountSiteNav('#sitenav');

  /* Researched names are optional: the page is still useful without them, so a
     missing or broken file must not take the whole list down. */
  try {
    const res = await fetch('./data/contacts.json', { headers: { 'cache-control': 'no-cache' } });
    if (res.ok) CONTACTS = (await res.json()).companies || {};
  } catch { CONTACTS = {}; }

  let rows = [];
  try {
    const res = await fetch(API, { headers: { 'cache-control': 'no-cache' } });
    const body = await res.json();
    rows = body.jobs || [];
  } catch (error) {
    at('#targets').innerHTML = `<p class="empty">The queue could not be read: ${esc(error.message)}</p>`;
    return;
  }

  const { fresh, applied, undated } = pickTargets(rows);
  const total = fresh.length + applied.length + undated.length;
  at('#count').textContent = total
    ? `${fresh.length} posted in the last ${FRESH_DAYS} days, ${applied.length} already applied for, `
      + `${undated.length} the board never dated.`
    : 'Nothing ranked and open right now.';

  const section = (heading, note, list) => list.length
    ? `<h2 class="group">${esc(heading)}</h2><p class="group-note">${esc(note)}</p>`
      + list.map(cardHtml).join('')
    : '';

  at('#targets').innerHTML = total
    ? section(`Posted in the last ${FRESH_DAYS} days`,
        'Open, ranked, and dated by the board inside your window.', fresh)
      + section('Already applied for',
          'A sent application is not a finished one. These are the rows to follow up on, '
          + 'and the people below each are who to follow up with.', applied)
      + section('No posted date',
          'The board published no date for these, so their age is unknown rather than old. '
          + 'Kept separate so nothing here is presented as fresh.', undated)
    : '<p class="empty">No ranked postings. The list refills twice a day.</p>';
  wireCopy();
}

main();
