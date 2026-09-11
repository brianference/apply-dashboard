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

import { searchesFor, messageShapes, cleanCompany } from './search-urls.js';

const API = '/api/jobs';
/** Enough to work through in a sitting. The method costs five minutes each. */
const SHOW = 25;
/** "New" for this page. He asked for top rated NEW jobs. */
const FRESH_DAYS = 14;

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
  return (rows || [])
    .filter((r) => r && r.status === 'queued' && r.url && r.rank_pct != null)
    .filter((r) => { const a = ageDays(r); return a === null || a <= FRESH_DAYS; })
    .sort((a, b) => (b.rank_pct || 0) - (a.rank_pct || 0))
    .slice(0, SHOW);
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
  const steps = searchesFor(row).map((s) => `
      <li>
        <a class="step" href="${esc(safeHref(s.url))}" target="_blank" rel="noopener noreferrer">
          <span class="n">${s.step}</span>${esc(s.label)}
        </a>
        <span class="why">${esc(s.why)}</span>
      </li>`).join('');

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
          </p>
        </div>
        <a class="posting" href="${esc(safeHref(row.url))}" target="_blank" rel="noopener noreferrer">The posting</a>
      </header>
      <ol class="steps">${steps}</ol>
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

  let rows = [];
  try {
    const res = await fetch(API, { headers: { 'cache-control': 'no-cache' } });
    const body = await res.json();
    rows = body.jobs || [];
  } catch (error) {
    at('#targets').innerHTML = `<p class="empty">The queue could not be read: ${esc(error.message)}</p>`;
    return;
  }

  const targets = pickTargets(rows);
  at('#count').textContent = targets.length
    ? `${targets.length} of the highest-ranked open postings from the last ${FRESH_DAYS} days.`
    : 'Nothing ranked and open in that window right now.';

  at('#targets').innerHTML = targets.length
    ? targets.map(cardHtml).join('')
    : '<p class="empty">No ranked postings inside the window. The list refills twice a day.</p>';
  wireCopy();
}

main();
