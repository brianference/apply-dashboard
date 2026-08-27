/**
 * Resolve aggregator listings by asking the employer's own ATS for its
 * postings and matching on title.
 *
 * ingest/resolve-outbound.mjs already tried to scrape the outbound apply URL
 * out of the aggregator page. It resolved 0 of 104. Himalayas answers a
 * headless fetch with Cloudflare 403 / "Just a moment..."; even past the
 * challenge the RSC payload serialises applicationLink as "$undefined" and
 * the Apply CTA points at /signup/talent. A link taken from a job-description
 * body produced a false positive (a greenhouse referral in the Orderly
 * Network posting that 404s). This module does not scrape aggregators and
 * does not read URLs out of description HTML.
 *
 * A resolved row comes from a board endpoint that returned HTTP 200 AND a
 * posting on that board whose title matches after normalisation. Anything
 * else is unresolved, with the reason and HTTP status recorded. A 404 token
 * never produces a URL, even if the error body looks like a jobs list.
 *
 *   node ingest/resolve-by-board.mjs
 *   node ingest/resolve-by-board.mjs --limit 8 --company "boulevard|mitratech"
 *   node ingest/resolve-by-board.mjs --host himalayas.app
 *   node ingest/resolve-by-board.mjs --write
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCli, parseArgs } from './cli.mjs';
import { loadCompanies } from './companies.mjs';
import { fetchText } from './http.mjs';
import { logInfo, logWarn, logError } from './logger.mjs';
import { salaryFromText } from './salary-from-posting.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'ingest', 'out');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

/** Hostnames that are indexes, not employer application forms. */
const AGGREGATORS = new Set([
  'workingnomads.com',
  'weworkremotely.com',
  'himalayas.app',
  'monster.com',
  'dice.com'
]);

/** ATS boards probed live on 2026-08-27; each returned 200 with no API key. */
export const ATS_ORDER = ['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'workable'];

const BOARD_URL = {
  greenhouse: (token) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`,
  ashby: (token) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`,
  lever: (token) => `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
  smartrecruiters: (token) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings`,
  workable: (token) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}`
};

const POSTING_URL = {
  greenhouse: (token, id) =>
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}?content=true`,
  smartrecruiters: (token, id) =>
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings/${encodeURIComponent(id)}`
};

const CORP_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation',
  'company', 'co', 'gmbh', 'plc', 'holdings', 'group', 'international',
  'lp', 'pc', 'pllc', 'sa', 'ag', 'nv', 'bv', 'pty', 'ab'
]);

const TRAILING_GENERIC = new Set([
  'technologies', 'technology', 'software', 'digital', 'labs', 'lab',
  'studios', 'studio', 'systems', 'solutions', 'services', 'networks',
  'network'
]);

const MIN_TOKEN_LENGTH = 2;
const MAX_SMARTRECRUITERS_POSTINGS = 500;

/**
 * Strip a leading www. so hostnames compare cleanly.
 * @param {string} url
 * @returns {string|null}
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Words of a company name, lowercased, punctuation gone, leading "the" and
 * trailing corporate suffixes dropped.
 * @param {string} name
 * @returns {string[]}
 */
export function companyWords(name) {
  let s = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  const words = s.split(/\s+/).filter(Boolean);
  while (words[0] === 'the') words.shift();
  while (words.length && CORP_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words;
}

/**
 * Comparable company name used to look up ingest/companies.json.
 * @param {string} name
 * @returns {string}
 */
export function normalizeCompanyName(name) {
  return companyWords(name).join(' ');
}

/**
 * Title matching is normalised (case, punctuation, whitespace, & vs and,
 * sr. vs senior) but not fuzzy-by-similarity.
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/\bsnr\.?\b/g, 'senior')
    .replace(/\bjr\.?\b/g, 'junior')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Postings whose normalised title equals the query. Empty titles never match.
 * @param {string} title
 * @param {Array<{title: string}>} postings
 * @returns {Array<{title: string}>}
 */
export function matchPostings(title, postings) {
  const want = normalizeTitle(title);
  if (!want) return [];
  const list = Array.isArray(postings) ? postings : [];
  return list.filter((p) => p && normalizeTitle(p.title) === want);
}

/**
 * Keep only an already-absolute http(s) URL. Relative paths, javascript:, and
 * description-body hrefs are not URLs we are willing to resolve to.
 * @param {...unknown} candidates
 * @returns {string|null}
 */
export function pickHttpUrl(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
}

/**
 * Candidate board tokens, most specific first. companies.json name matches
 * come before guesses. A bad token is cheap (it 404s); a bad title match is
 * not, so this widens tokens, not titles.
 *
 * @param {string} companyName
 * @param {{greenhouse?: Array<{token:string,name:string}>, lever?: Array<{token:string,name:string}>, ashby?: Array<{token:string,name:string}>}} [companies]
 * @returns {Array<{token: string, preferredAts: string[], source: string}>}
 */
export function boardTokens(companyName, companies = {}) {
  /** @type {Map<string, {token: string, preferredAts: string[], source: string}>} */
  const byToken = new Map();

  /**
   * @param {string} token
   * @param {string[]} preferredAts
   * @param {string} source
   */
  const add = (token, preferredAts, source) => {
    const t = String(token || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!t || t.length < MIN_TOKEN_LENGTH) return;
    const existing = byToken.get(t);
    if (existing) {
      for (const ats of preferredAts) {
        if (!existing.preferredAts.includes(ats)) existing.preferredAts.push(ats);
      }
      return;
    }
    byToken.set(t, { token: t, preferredAts: [...preferredAts], source });
    /* Map insertion order is the candidate order: json hits first, then guesses. */
  };

  const want = normalizeCompanyName(companyName);
  for (const ats of ['greenhouse', 'lever', 'ashby']) {
    const list = Array.isArray(companies[ats]) ? companies[ats] : [];
    for (const row of list) {
      if (!row || !row.token) continue;
      if (want && normalizeCompanyName(row.name) === want) {
        add(row.token, [ats], 'companies.json');
      }
    }
  }

  const words = companyWords(companyName);
  if (!words.length) return [...byToken.values()];

  const forms = [];
  forms.push(words);
  const stripped = [...words];
  while (stripped.length > 1 && TRAILING_GENERIC.has(stripped[stripped.length - 1])) {
    stripped.pop();
    forms.push([...stripped]);
  }

  for (const form of forms) {
    add(form.join('-'), [], 'guessed');
    add(form.join(''), [], 'guessed');
  }
  if (words.length > 1) {
    add(words.map((w) => w[0]).join(''), [], 'guessed-initialism');
    add(words[0], [], 'guessed-first-word');
  }

  for (const ats of ['greenhouse', 'lever', 'ashby']) {
    const list = Array.isArray(companies[ats]) ? companies[ats] : [];
    for (const row of list) {
      if (!row || !row.token) continue;
      const hit = byToken.get(String(row.token).toLowerCase());
      if (hit && !hit.preferredAts.includes(ats)) hit.preferredAts.push(ats);
    }
  }

  return [...byToken.values()];
}

/**
 * @param {unknown} html
 * @returns {string}
 */
function textFromHtml(html) {
  return String(html || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Yearly band from a Lever salaryRange object. Hourly / monthly / weekly
 * intervals are ignored — converting them would be an estimate.
 * @param {unknown} range
 * @returns {{min: number, max: number}|null}
 */
function yearlyLeverSalary(range) {
  if (!range || typeof range !== 'object') return null;
  const interval = String(range.interval || '');
  if (interval && !/year/i.test(interval)) return null;
  const min = Number(range.min);
  const max = Number(range.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min < 50000 || max > 800000 || max < min) return null;
  return { min, max };
}

/**
 * Map one ATS list payload onto {title, url, salaryText, raw}. URL is taken
 * only from fields the board itself published. Description-body hrefs are
 * ignored.
 *
 * @param {string} ats
 * @param {unknown} payload
 * @returns {Array<{title: string, url: string|null, salaryText: string, id: string|null, structuredSalary: {min:number, max:number}|null, raw: object}>}
 */
export function parseBoardPostings(ats, payload) {
  /** @param {object} job @param {string} title @param {string|null} url @param {string} [salaryText] @param {{min:number,max:number}|null} [structured] */
  const row = (job, title, url, salaryText = '', structured = null) => ({
    title: String(title || ''),
    url,
    salaryText: String(salaryText || ''),
    id: job && (job.id != null) ? String(job.id) : null,
    structuredSalary: structured,
    raw: job
  });

  if (ats === 'greenhouse') {
    const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
    return jobs.map((job) => row(job, job && job.title, pickHttpUrl(job && job.absolute_url)));
  }
  if (ats === 'ashby') {
    const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
    return jobs.map((job) => {
      const c = job && job.compensation;
      const salaryText = [
        c && typeof c.compensationTierSummary === 'string' ? c.compensationTierSummary : '',
        c && typeof c.scrapeableCompensationSalarySummary === 'string' ? c.scrapeableCompensationSalarySummary : '',
        typeof (job && job.descriptionPlain) === 'string' ? job.descriptionPlain : '',
        typeof (job && job.descriptionHtml) === 'string' ? textFromHtml(job.descriptionHtml) : ''
      ].filter(Boolean).join('\n');
      return row(job, job && job.title, pickHttpUrl(job && job.jobUrl, job && job.applyUrl), salaryText);
    });
  }
  if (ats === 'lever') {
    const jobs = Array.isArray(payload) ? payload : [];
    return jobs.map((job) => row(
      job,
      job && (job.text || job.title),
      pickHttpUrl(job && job.hostedUrl, job && job.applyUrl),
      typeof (job && job.descriptionPlain) === 'string' ? job.descriptionPlain : '',
      yearlyLeverSalary(job && job.salaryRange)
    ));
  }
  if (ats === 'smartrecruiters') {
    const jobs = payload && Array.isArray(payload.content) ? payload.content : [];
    return jobs.map((job) => row(
      job,
      job && (job.name || job.title),
      pickHttpUrl(job && job.postingUrl, job && job.applyUrl, job && job.url)
    ));
  }
  if (ats === 'workable') {
    const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
    return jobs.map((job) => row(
      job,
      job && job.title,
      pickHttpUrl(job && job.url, job && job.application_url)
    ));
  }
  return [];
}

/**
 * Salary from THIS posting only. Never from a sibling, never estimated.
 * @param {{salaryText?: string, structuredSalary?: {min:number, max:number}|null, raw?: object}} posting
 * @returns {{min: number|null, max: number|null, source: string|null}}
 */
export function salaryFromPosting(posting) {
  if (posting && posting.structuredSalary && posting.structuredSalary.min) {
    return {
      min: posting.structuredSalary.min,
      max: posting.structuredSalary.max,
      source: 'posting'
    };
  }
  const fromText = salaryFromText(posting && posting.salaryText ? posting.salaryText : '');
  if (fromText.min) return { min: fromText.min, max: fromText.max, source: 'posting' };
  return { min: null, max: null, source: null };
}

/**
 * Flatten SmartRecruiters jobAd section text for the salary extractor.
 * @param {unknown} detail
 * @returns {string}
 */
function smartRecruitersAdText(detail) {
  const sections = detail && detail.jobAd && detail.jobAd.sections;
  if (!sections || typeof sections !== 'object') return '';
  const parts = [];
  for (const value of Object.values(sections)) {
    if (value && typeof value.text === 'string') parts.push(value.text);
    else if (value && typeof value === 'string') parts.push(value);
  }
  return textFromHtml(parts.join('\n'));
}

/**
 * Fetch one board list. 404 is a result, not a throw. A 200 body that is not
 * JSON is not a board.
 *
 * @param {string} ats
 * @param {string} token
 * @returns {Promise<{status: number|null, json: unknown, error: string|null}>}
 */
export async function fetchBoard(ats, token) {
  const build = BOARD_URL[ats];
  if (!build) return { status: null, json: null, error: `no board url for ats ${ats}` };
  const url = build(token);
  try {
    const res = await fetchText(url);
    if (res.status !== 200) {
      return { status: res.status, json: null, error: `board returned ${res.status}` };
    }
    let json;
    try {
      json = JSON.parse(res.text);
    } catch {
      return { status: res.status, json: null, error: 'board did not return JSON' };
    }
    if (ats === 'smartrecruiters' && json && typeof json.totalFound === 'number' && Array.isArray(json.content)) {
      const listed = json.content.length;
      while (json.content.length < json.totalFound && json.content.length < MAX_SMARTRECRUITERS_POSTINGS) {
        const pageUrl = `${url}${url.includes('?') ? '&' : '?'}offset=${json.content.length}&limit=100`;
        const more = await fetchText(pageUrl);
        if (more.status !== 200) break;
        let extra;
        try { extra = JSON.parse(more.text); } catch { break; }
        const batch = extra && Array.isArray(extra.content) ? extra.content : [];
        if (!batch.length) break;
        json.content.push(...batch);
      }
      if (json.totalFound > json.content.length) {
        logWarn('smartrecruiters list truncated', {
          token,
          got: json.content.length,
          totalFound: json.totalFound,
          dropped: json.totalFound - json.content.length
        });
      } else if (listed < json.content.length) {
        logInfo('smartrecruiters pages fetched', { token, totalFound: json.totalFound });
      }
    }
    return { status: 200, json, error: null };
  } catch (err) {
    return { status: null, json: null, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Fetch one posting's detail payload (Greenhouse content, SmartRecruiters
 * postingUrl). Only called after a 200 list match.
 *
 * @param {string} ats
 * @param {string} token
 * @param {{id: string|null}} posting
 * @returns {Promise<{status: number|null, json: unknown, error: string|null}>}
 */
export async function fetchPostingDetail(ats, token, posting) {
  const build = POSTING_URL[ats];
  if (!build || !posting || !posting.id) {
    return { status: null, json: null, error: 'no posting detail url' };
  }
  const url = build(token, posting.id);
  try {
    const res = await fetchText(url);
    if (res.status !== 200) {
      return { status: res.status, json: null, error: `posting returned ${res.status}` };
    }
    try {
      return { status: 200, json: JSON.parse(res.text), error: null };
    } catch {
      return { status: res.status, json: null, error: 'posting did not return JSON' };
    }
  } catch (err) {
    return { status: null, json: null, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Fill URL / salary from a posting-detail 200, still without inventing a URL.
 * @param {string} ats
 * @param {object} posting
 * @param {unknown} detail
 * @returns {object}
 */
function applyPostingDetail(ats, posting, detail) {
  if (!detail || typeof detail !== 'object') return posting;
  const next = { ...posting, raw: posting.raw };
  if (ats === 'greenhouse') {
    if (!next.url) next.url = pickHttpUrl(detail.absolute_url);
    const content = typeof detail.content === 'string' ? textFromHtml(detail.content) : '';
    if (content) next.salaryText = [next.salaryText, content].filter(Boolean).join('\n');
  }
  if (ats === 'smartrecruiters') {
    if (!next.url) next.url = pickHttpUrl(detail.postingUrl, detail.applyUrl);
    const ad = smartRecruitersAdText(detail);
    if (ad) next.salaryText = [next.salaryText, ad].filter(Boolean).join('\n');
  }
  return next;
}

/**
 * Resolve one aggregator row against employer boards.
 *
 * @param {{company: string, title: string, url?: string, dedupe_key?: string}} job
 * @param {{
 *   companies?: object,
 *   fetchBoard?: typeof fetchBoard,
 *   fetchPostingDetail?: typeof fetchPostingDetail,
 *   cache?: Map<string, {status: number|null, json: unknown, error: string|null}>
 * }} [deps]
 * @returns {Promise<object>}
 */
export async function resolveJob(job, deps = {}) {
  const companies = deps.companies || {};
  const getBoard = deps.fetchBoard || fetchBoard;
  const getDetail = deps.fetchPostingDetail || fetchPostingDetail;
  const cache = deps.cache || new Map();
  const candidates = boardTokens(job.company, companies);
  /** @type {Array<{ats: string, token: string, status: number|null, error: string|null, postings: number}>} */
  const attempts = [];

  const base = {
    dedupe_key: job.dedupe_key || null,
    company: job.company,
    title: job.title,
    aggregator_host: hostOf(job.url || ''),
    aggregator_url: job.url || null,
    url: null,
    ats: 'unresolved',
    token: null,
    method: 'board-title-match',
    http_status: null,
    error: null,
    reason: null,
    salary_min: null,
    salary_max: null,
    salary_source: null,
    attempts
  };

  /**
   * @param {string} reason
   * @param {string} error
   * @param {number|null} status
   * @param {{ats?: string, token?: string}} [extra]
   */
  const miss = (reason, error, status, extra = {}) => ({
    ...base,
    reason,
    error,
    http_status: status,
    ats: 'unresolved',
    token: extra.token || null,
    url: null,
    salary_min: null,
    salary_max: null,
    salary_source: null,
    ...(extra.ats ? { decided_ats: extra.ats } : {})
  });

  if (!candidates.length) {
    return miss('no-board', 'no-board: company name produced no board tokens', null);
  }

  let sawBoard = false;
  let lastNoTitle = null;

  for (const cand of candidates) {
    const atsList = [];
    for (const ats of cand.preferredAts) if (ATS_ORDER.includes(ats) && !atsList.includes(ats)) atsList.push(ats);
    for (const ats of ATS_ORDER) if (!atsList.includes(ats)) atsList.push(ats);

    let tokenHad200 = false;

    for (const ats of atsList) {
      const key = `${ats}::${cand.token}`;
      let board = cache.get(key);
      if (!board) {
        board = await getBoard(ats, cand.token);
        cache.set(key, board);
      }
      attempts.push({
        ats,
        token: cand.token,
        status: board.status,
        error: board.error,
        postings: 0
      });
      if (board.status !== 200 || board.json == null) continue;

      const postings = parseBoardPostings(ats, board.json);
      attempts[attempts.length - 1].postings = postings.length;
      /* Greenhouse and Ashby 404 a bogus token. SmartRecruiters and Workable
         answer HTTP 200 with an empty list instead (Visa, stripe, gitlab all
         200/0 on 2026-08-27). An empty 200 is not a board we can match, and
         treating it as one would stop the walk before a real greenhouse token
         is tried. */
      if (postings.length === 0) continue;

      tokenHad200 = true;
      sawBoard = true;
      const matched = matchPostings(job.title, postings);

      if (matched.length > 1) {
        return miss(
          'ambiguous',
          `ambiguous: ${matched.length} postings on ${ats}/${cand.token} match "${job.title}"`,
          200,
          { ats, token: cand.token }
        );
      }
      if (matched.length !== 1) {
        lastNoTitle = { ats, token: cand.token, postings: postings.length, status: 200 };
        continue;
      }

      let posting = matched[0];
      if ((ats === 'greenhouse' || ats === 'smartrecruiters') && posting.id) {
        const detail = await getDetail(ats, cand.token, posting);
        if (detail.status === 200 && detail.json) {
          posting = applyPostingDetail(ats, posting, detail.json);
        }
      }
      if (!posting.url) {
        return miss(
          'no-url-on-posting',
          `no-url-on-posting: ${ats}/${cand.token} matched "${job.title}" but published no apply URL`,
          200,
          { ats, token: cand.token }
        );
      }
      const pay = salaryFromPosting(posting);
      return {
        ...base,
        url: posting.url,
        ats,
        token: cand.token,
        method: 'board-title-match',
        http_status: 200,
        error: null,
        reason: null,
        salary_min: pay.min,
        salary_max: pay.max,
        salary_source: pay.source
      };
    }

    if (tokenHad200) break;
  }

  if (lastNoTitle) {
    return miss(
      'no-title-match',
      `no-title-match: board ${lastNoTitle.ats}/${lastNoTitle.token} returned 200 with ${lastNoTitle.postings} postings, none matching "${job.title}"`,
      lastNoTitle.status,
      { ats: lastNoTitle.ats, token: lastNoTitle.token }
    );
  }
  if (sawBoard) {
    return miss('no-title-match', `no-title-match: a board returned 200 but none matched "${job.title}"`, 200);
  }
  const statuses = attempts.map((a) => a.status).filter((s) => s != null);
  const status = statuses.length ? statuses[statuses.length - 1] : null;
  return miss('no-board', 'no-board: every token returned 404 or failed', status);
}

/**
 * Summarise resolved / unresolved rows for the report.
 * @param {object[]} rows
 * @returns {{total: number, resolved: number, unresolved: number, by_ats: Record<string, number>, unresolved_reasons: Record<string, number>}}
 */
export function summarise(rows) {
  const by_ats = {};
  const unresolved_reasons = {};
  let resolved = 0;
  for (const row of rows) {
    if (row.url) {
      resolved += 1;
      by_ats[row.ats] = (by_ats[row.ats] || 0) + 1;
    } else {
      const reason = row.reason || 'unresolved';
      unresolved_reasons[reason] = (unresolved_reasons[reason] || 0) + 1;
    }
  }
  return {
    total: rows.length,
    resolved,
    unresolved: rows.length - resolved,
    by_ats,
    unresolved_reasons
  };
}

/**
 * Write url + published salary onto matched D1 rows. Same REST path as
 * ingest/fit-score.mjs (CF_D1_TOKEN, accounts/.../d1/database/.../query).
 *
 * @param {object[]} rows
 * @param {string} token
 * @returns {Promise<number>}
 */
export async function writeMatches(rows, token) {
  /**
   * @param {string} sql
   * @param {Array<string|number|null>} params
   */
  const run = async (sql, params) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params })
    });
    const j = await r.json();
    if (!j.success) throw new Error(JSON.stringify(j.errors));
    return j;
  };
  /* Bound parameters, never interpolation. Every value below is third-party
     text off somebody else's job board, and a hand-rolled quote-doubler is the
     exact shape a previous review caught here. The D1 REST endpoint takes
     {sql, params} -- verified against the live database on 2026-08-27 with
     `SELECT count(*) FROM jobs WHERE company = ?`, which returned success. */
  const SQL = 'UPDATE jobs SET url = ?, salary_min = ?, salary_max = ?, salary_source = ?'
    + ' WHERE dedupe_key = ?';
  let wrote = 0;
  for (const row of rows) {
    if (!row.url || !row.dedupe_key) continue;
    await run(SQL, [
      String(row.url),
      row.salary_min == null ? null : Number(row.salary_min),
      row.salary_max == null ? null : Number(row.salary_max),
      row.salary_source == null || row.salary_source === '' ? null : String(row.salary_source),
      String(row.dedupe_key)
    ]);
    wrote += 1;
  }
  return wrote;
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const limit = args.limit === undefined || args.limit === true ? Infinity : Number(args.limit);
  const companyRe = args.company && args.company !== true ? new RegExp(String(args.company), 'i') : null;
  const onlyHost = args.host && args.host !== true ? String(args.host).replace(/^www\./, '') : null;
  const doWrite = !!args.write;

  let live;
  try {
    live = await fetch(API, { headers: { 'cache-control': 'no-cache' } }).then((r) => r.json());
  } catch (err) {
    logError(`could not read ${API}`, { error: String(err && err.message ? err.message : err) });
    process.exit(1);
  }

  const queued = (live.jobs || []).filter((j) => j.status === 'queued');
  const withHost = queued.map((j) => ({ ...j, host: hostOf(j.url) }));
  const aggregators = withHost.filter((j) => j.host && AGGREGATORS.has(j.host));
  if (queued.length !== aggregators.length) {
    logInfo('non-aggregator queued rows skipped', {
      queued: queued.length,
      aggregators: aggregators.length,
      dropped: queued.length - aggregators.length
    });
  }

  /* A posting Brian's own rules already threw out does not need an apply URL.
     41 of the 105 aggregator rows on the first run carried a RULED_OUT reason
     -- eight of them resolved, which is forty percent of the work spent on
     jobs he cannot take. The reasons here are the same set apply/batch.mjs
     refuses to apply to; keep them identical or the two disagree. */
  const RULED_OUT = new Set(['location-ineligible', 'posting-closed', 'off-criteria', 'duplicate-posting']);
  let selected = aggregators.filter((j) => !RULED_OUT.has(String(j.blocked_reason || '')));
  if (selected.length !== aggregators.length) {
    logInfo('ruled-out rows skipped', {
      aggregators: aggregators.length,
      eligible: selected.length,
      dropped: aggregators.length - selected.length
    });
  }
  if (onlyHost) {
    const before = selected.length;
    selected = selected.filter((j) => j.host === onlyHost);
    logInfo('host filter dropped rows', {
      host: onlyHost,
      before,
      after: selected.length,
      dropped: before - selected.length
    });
  }
  if (companyRe) {
    const before = selected.length;
    selected = selected.filter((j) => companyRe.test(String(j.company || '')));
    logInfo('company filter dropped rows', {
      pattern: String(args.company),
      before,
      after: selected.length,
      dropped: before - selected.length
    });
  }
  if (Number.isFinite(limit) && selected.length > limit) {
    logInfo('limit dropped rows', {
      limit,
      before: selected.length,
      after: limit,
      dropped: selected.length - limit
    });
    selected = selected.slice(0, limit);
  }

  const companies = await loadCompanies();
  const cache = new Map();
  logInfo(`resolving ${selected.length} aggregator rows against employer boards`);

  const rows = [];
  for (const job of selected) {
    let row;
    try {
      row = await resolveJob(job, { companies, cache });
    } catch (err) {
      row = {
        dedupe_key: job.dedupe_key || null,
        company: job.company,
        title: job.title,
        aggregator_host: job.host,
        aggregator_url: job.url,
        url: null,
        ats: 'unresolved',
        token: null,
        method: 'board-title-match',
        http_status: null,
        error: String(err && err.message ? err.message : err).split('\n')[0],
        reason: 'fetch-error',
        salary_min: null,
        salary_max: null,
        salary_source: null,
        attempts: []
      };
    }
    rows.push(row);
    if (row.url) {
      logInfo('resolved', {
        company: job.company,
        ats: row.ats,
        token: row.token,
        url: row.url
      });
    } else {
      logInfo('unresolved', {
        company: job.company,
        reason: row.reason,
        http_status: row.http_status,
        error: row.error
      });
    }
  }

  const counts = summarise(rows);
  const out = {
    generated_at: new Date().toISOString(),
    counts,
    dropped: {
      queued: queued.length,
      non_aggregator: queued.length - aggregators.length,
      after_filters: selected.length
    },
    rows
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'resolve-by-board.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

  logInfo(`resolved ${counts.resolved}/${counts.total}`);
  const atsEntries = Object.entries(counts.by_ats);
  if (atsEntries.length) {
    for (const [ats, n] of atsEntries) logInfo(`  ats ${ats}: ${n}`);
  } else {
    logInfo('  ats: none');
  }
  const reasonEntries = Object.entries(counts.unresolved_reasons);
  if (reasonEntries.length) {
    for (const [reason, n] of reasonEntries) logInfo(`  unresolved ${reason}: ${n}`);
  } else {
    logInfo('  unresolved reasons: none');
  }
  logInfo(`wrote ${path.relative(ROOT, outPath).replace(/\\/g, '/')}`);

  if (doWrite) {
    const cf = process.env.CF_D1_TOKEN || '';
    if (!cf) {
      logError('CF_D1_TOKEN not set - nothing written.');
      process.exitCode = 1;
    } else {
      const wrote = await writeMatches(rows, cf);
      logInfo(`wrote ${wrote} matched rows to D1`);
    }
  }
}
