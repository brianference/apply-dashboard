/**
 * One job-description reader, with tiers, so a second copy cannot drift
 * the way the normalised dedupe check used to live in only one of two
 * places.
 *
 * fetchJd in fit-score.mjs is the public entry point and returns the
 * description string existing callers already expect. This module is what
 * it delegates to. The richer result (outcome, salary, posted) is how a
 * JSON-LD date and band are taken from the same fetch that got the text,
 * instead of leaving 64 rows undated and 180 unpriced.
 */

import { isoFromUnknown } from './jobs.mjs';
import { salaryFromText } from './salary-from-posting.mjs';

/** Survey threshold: JSON-LD JobPosting.description counted as a read above this. */
export const JSONLD_DESC_MIN = 400;
/** Survey threshold: plain page text counted as a read above this. */
export const PAGE_TEXT_MIN = 1200;

const BLOCKED_HOSTS = [
  'linkedin.com',
  'indeed.com',
  'dice.com',
  'monster.com',
  'wellfound.com',
  'startup.jobs'
];

/* 404/410 boards and the four SCRAPED hosts that return ~120 chars of
   nothing. Attempting them forever is what made 46 percent of the list
   look like a defect. */
const DEAD_HOSTS = [
  'careers.airbnb.com',
  'cribl.io',
  'jobs.gusto.com',
  'flexgen.zya.me',
  'homebased.totalh.net',
  'lynqo.liveblog365.com',
  'talentpulse.66ghz.com'
];

/**
 * Hostname without a leading www, or '' if the URL cannot be parsed.
 *
 * @param {string} url
 * @returns {string}
 */
function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * @param {string} host
 * @param {string} listed
 * @returns {boolean}
 */
function hostMatches(host, listed) {
  return host === listed || host.endsWith('.' + listed);
}

/**
 * Why this URL must not be fetched, or null if a tier may try.
 *
 * blocked-by-policy is LinkedIn/Indeed and the rest of the boards whose
 * terms forbid automated reads. board-404 is a host that is gone or is
 * one of the four SCRAPED placeholders. Returning null here is not a
 * promise the page will work -- icims still has to be attempted and then
 * marked unreadable-host.
 *
 * @param {string} url
 * @returns {'blocked-by-policy'|'board-404'|null}
 */
export function hostPolicy(url) {
  const host = hostnameOf(url);
  if (!host) return null;
  if (BLOCKED_HOSTS.some((h) => hostMatches(host, h))) return 'blocked-by-policy';
  if (DEAD_HOSTS.some((h) => hostMatches(host, h))) return 'board-404';
  return null;
}

/**
 * Workday CXS JSON URL for a posting page, or null.
 *
 * The first matcher required `<tenant>.<wd>.myworkdayjobs.com/<site>/job/<path>`
 * and silently dropped every URL that carried a locale segment
 * (`/en-US/external_experienced/job/...`). Adobe, Cisco and Capital One
 * all look like that. Locale is optional; it is not part of the CXS path.
 *
 * @param {string} pageUrl
 * @returns {string|null}
 */
export function workdayCxsUrl(pageUrl) {
  let parsed;
  try {
    parsed = new URL(String(pageUrl || ''));
  } catch {
    return null;
  }
  const hostMatch = parsed.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
  if (!hostMatch) return null;
  const tenant = hostMatch[1];
  const parts = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  let i = 0;
  if (parts[0] && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) i = 1;
  if (parts.length < i + 3) return null;
  const site = parts[i];
  if (parts[i + 1] !== 'job') return null;
  const jobPath = parts.slice(i + 2).join('/');
  if (!site || !jobPath) return null;
  return `https://${parsed.hostname}/wday/cxs/${tenant}/${site}/job/${jobPath}`;
}

/**
 * Last path segment, used as a Himalayas slug.
 *
 * @param {string} url
 * @returns {string}
 */
export function urlSlug(url) {
  try {
    const parts = new URL(url).pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  } catch {
    const parts = String(url || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }
}

/**
 * Find a Himalayas feed job for a listing URL, by applicationLink, guid,
 * or last-path slug. The page is 403 to every user-agent we tried; the
 * feed is the only read that works.
 *
 * @param {Array<Record<string, unknown>>} jobs
 * @param {string} url
 * @returns {Record<string, unknown>|null}
 */
export function matchHimalayasJob(jobs, url) {
  const want = String(url || '').replace(/\/+$/, '');
  const slug = urlSlug(url);
  if (!want && !slug) return null;
  for (const job of jobs || []) {
    if (!job || typeof job !== 'object') continue;
    const link = String(job.applicationLink || '').replace(/\/+$/, '');
    const guid = String(job.guid || '').replace(/\/+$/, '');
    if (want && (link === want || guid === want)) return job;
    if (slug && (urlSlug(link) === slug || urlSlug(guid) === slug || guid === slug)) return job;
  }
  return null;
}

/**
 * @param {unknown} typeVal
 * @returns {boolean}
 */
function isJobPostingType(typeVal) {
  if (typeVal === 'JobPosting') return true;
  if (Array.isArray(typeVal)) return typeVal.indexOf('JobPosting') !== -1;
  return false;
}

/**
 * Walk a parsed ld+json value for JobPosting nodes. Arrays and @graph are
 * how WeWorkRemotely and Working Nomads actually emit the block; a walker
 * that only accepted a lone object would still "work" on a hand-built
 * fixture and miss those hosts.
 *
 * @param {unknown} node
 * @param {Array<Record<string, unknown>>} found
 */
function walkJobPosting(node, found) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const el of node) walkJobPosting(el, found);
    return;
  }
  const rec = /** @type {Record<string, unknown>} */ (node);
  if (isJobPostingType(rec['@type'])) found.push(rec);
  if (rec['@graph']) walkJobPosting(rec['@graph'], found);
}

/**
 * JobPosting taken from page HTML, or null.
 *
 * Each `<script type="application/ld+json">` is parsed on its own so a
 * malformed block in front of a good one cannot hide the posting -- that
 * is the shape Jobspresso-style pages can emit after a CMS glitch, and
 * throwing on the first block is how a real description would stay unread.
 *
 * @param {string} html
 * @param {Date} [now]
 * @returns {{ title: string, description: string, datePosted: string|null, validThrough: string|null, baseSalary: unknown }|null}
 */
export function extractJsonLdJobPosting(html, now = new Date()) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) blocks.push(m[1]);
  const found = [];
  for (const raw of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    walkJobPosting(parsed, found);
  }
  const job = found[0];
  if (!job) return null;
  const descRaw = job.description == null ? '' : String(job.description);
  const description = htmlToText(descRaw);
  return {
    title: job.title == null ? '' : String(job.title),
    description,
    datePosted: clampPostedIso(job.datePosted == null ? null : String(job.datePosted), now),
    validThrough: job.validThrough == null || job.validThrough === ''
      ? null
      : clampPostedIso(String(job.validThrough), now) || String(job.validThrough),
    baseSalary: job.baseSalary
  };
}

/**
 * Annual USD band from a JSON-LD JobPosting.baseSalary, or null.
 *
 * Hourly and monthly figures, and anything not in USD, are refused: reading
 * $85/hour as $85,000 a year (or as $176,800) would rule a job in or out
 * on a number the employer did not publish as salary.
 *
 * @param {unknown} jobPosting
 * @returns {{ min: number|null, max: number|null }|null}
 */
export function salaryFromJsonLd(jobPosting) {
  if (!jobPosting || typeof jobPosting !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (jobPosting);
  const blocks = Array.isArray(rec.baseSalary) ? rec.baseSalary : [rec.baseSalary];
  for (const block of blocks) {
    const band = salaryFromMonetaryAmount(block);
    if (band) return band;
  }
  return null;
}

/**
 * @param {unknown} amount
 * @returns {{ min: number|null, max: number|null }|null}
 */
function salaryFromMonetaryAmount(amount) {
  if (!amount || typeof amount !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (amount);
  const currency = String(rec.currency || rec.currencyCode || '').toUpperCase();
  if (currency !== 'USD') return null;
  const value = rec.value && typeof rec.value === 'object'
    ? /** @type {Record<string, unknown>} */ (rec.value)
    : rec;
  const unit = String(value.unitText || rec.unitText || '').toUpperCase();
  if (!unit || !/\bYEAR/.test(unit) || /\b(HOUR|WEEK|MONTH|DAY)\b/.test(unit)) return null;
  const minRaw = Number(value.minValue != null ? value.minValue : value.value);
  const maxRaw = Number(value.maxValue != null ? value.maxValue : value.value);
  const min = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : null;
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null;
  if (min == null && max == null) return null;
  if (min != null && max != null && max < min) return null;
  return { min, max };
}

/**
 * A datePosted in the future clamps to now, matching ageDays: a negative
 * age would sort a not-yet-public posting as "today" in one place and as
 * a future date in another.
 *
 * @param {string|null|undefined} value
 * @param {Date} [now]
 * @returns {string|null}
 */
export function clampPostedIso(value, now = new Date()) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() > now.getTime()) return now.toISOString();
  return date.toISOString();
}

/**
 * Structured salary precedence. Ashby's compensation field is a number the
 * employer typed; JSON-LD is still structured but a step further from the
 * ATS; a regex over prose is last because it is the one that has matched
 * a neighbouring listing's band.
 *
 * @param {{
 *   ashby?: { min: number|null, max: number|null }|null,
 *   jsonld?: { min: number|null, max: number|null }|null,
 *   himalayas?: { min: number|null, max: number|null }|null,
 *   prose?: { min: number|null, max: number|null }|null
 * }} parts
 * @returns {{ min: number|null, max: number|null, source: string|null }}
 */
export function pickSalary(parts = {}) {
  const has = (band) => band && (band.min != null || band.max != null);
  if (has(parts.ashby)) {
    return { min: parts.ashby.min, max: parts.ashby.max, source: 'ashby:compensation' };
  }
  if (has(parts.himalayas)) {
    return { min: parts.himalayas.min, max: parts.himalayas.max, source: 'himalayas:api' };
  }
  if (has(parts.jsonld)) {
    return { min: parts.jsonld.min, max: parts.jsonld.max, source: 'jsonld:baseSalary' };
  }
  if (has(parts.prose)) {
    return { min: parts.prose.min, max: parts.prose.max, source: 'posting:page' };
  }
  return { min: null, max: null, source: null };
}

/**
 * @param {string} html
 * @returns {string}
 */
export function readablePageText(html) {
  const cut = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return htmlToText(cut);
}

/**
 * @param {string} outcome
 * @param {{ via?: string|null, closed?: boolean }} [extra]
 * @returns {JdReadResult}
 */
function emptyResult(outcome, extra = {}) {
  return {
    text: null,
    outcome,
    salary: null,
    salarySource: null,
    posted: null,
    validThrough: null,
    closed: extra.closed === true,
    via: extra.via || null
  };
}

/**
 * @typedef {{
 *   text: string|null,
 *   outcome: 'read'|'blocked-by-policy'|'board-404'|'unreadable-host'|'never-tried',
 *   salary: { min: number|null, max: number|null }|null,
 *   salarySource: string|null,
 *   posted: string|null,
 *   validThrough: string|null,
 *   closed: boolean,
 *   via: 'board-api'|'workday-cxs'|'himalayas'|'json-ld'|'page-text'|null
 * }} JdReadResult
 */

let fitMod = null;
/**
 * Helpers from fit-score.mjs. Bound at load of that module so this file
 * can call strip/boardRef without a circular import at the top of either.
 *
 * @returns {{ strip: (html: string) => string, boardRef: (url: string) => { ats: string, token: string, id: string }|null, fetchBoardJd: Function }}
 */
function loadFit() {
  if (!fitMod) {
    throw new Error('jd-read: fit-score helpers were not bound -- call bindFit() first');
  }
  return fitMod;
}

/**
 * @param {{ strip: Function, boardRef: Function, fetchBoardJd: Function }} mod
 */
export function bindFit(mod) {
  fitMod = mod;
}

/**
 * HTML to text for JSON-LD descriptions. Prefers strip() once fit-score
 * has bound it, so Greenhouse entity decoding and block separators stay
 * one implementation. Falls back to a one-pass decode so a unit test that
 * has not loaded fit-score yet can still prove the JobPosting walker.
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  if (fitMod && typeof fitMod.strip === 'function') return fitMod.strip(html);
  let s = String(html || '');
  for (let i = 0; i < 8; i++) {
    const prev = s;
    s = s
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, (_full, digits) => {
        const n = Number(digits);
        return Number.isFinite(n) ? String.fromCharCode(n) : _full;
      })
      .replace(/&amp;/gi, '&')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (s === prev) break;
  }
  return s;
}

/**
 * Himalayas structured band. Same USD-and-annual rule as JSON-LD: an
 * hourly figure in the feed must not be stored as a yearly salary.
 *
 * @param {Record<string, unknown>} job
 * @returns {{ min: number|null, max: number|null }|null}
 */
function salaryFromHimalayasJob(job) {
  if (String(job.currency || '').toUpperCase() !== 'USD') return null;
  const period = String(job.salaryPeriod || 'annual').toLowerCase();
  if (period !== 'annual') return null;
  const minRaw = Number(job.minSalary);
  const maxRaw = Number(job.maxSalary);
  const min = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : null;
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null;
  if (min == null && max == null) return null;
  return { min, max };
}

/**
 * @param {typeof fetch} get
 * @param {string} url
 * @returns {Promise<{ status: number, text: string, json: unknown }>}
 */
async function getUrl(get, url) {
  const res = await get(url, {
    headers: {
      accept: 'application/json, text/html;q=0.9, */*;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    },
    redirect: 'follow'
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

/**
 * @param {string} html
 * @param {Date} now
 * @returns {JdReadResult|null}
 */
function fromJsonLdHtml(html, now) {
  const job = extractJsonLdJobPosting(html, now);
  if (!job || !job.description || job.description.length < JSONLD_DESC_MIN) return null;
  const jsonld = salaryFromJsonLd({ baseSalary: job.baseSalary });
  const prose = salaryFromText(job.description);
  const picked = pickSalary({ jsonld, prose });
  return {
    text: job.description,
    outcome: 'read',
    salary: picked.min != null || picked.max != null ? { min: picked.min, max: picked.max } : null,
    salarySource: picked.source,
    posted: job.datePosted,
    validThrough: job.validThrough,
    closed: false,
    via: 'json-ld'
  };
}

/**
 * @param {string} html
 * @returns {JdReadResult|null}
 */
function fromPageText(html) {
  const text = readablePageText(html);
  if (!text || text.length <= PAGE_TEXT_MIN) return null;
  const prose = salaryFromText(text);
  const picked = pickSalary({ prose });
  return {
    text,
    outcome: 'read',
    salary: picked.min != null || picked.max != null ? { min: picked.min, max: picked.max } : null,
    salarySource: picked.source,
    posted: null,
    validThrough: null,
    closed: false,
    via: 'page-text'
  };
}

/**
 * Read a posting through the five tiers. Blocked and known-dead hosts
 * return without calling fetch -- that is the distinction the 145 unread
 * rows were missing. A 404 on a board we did try is posting-closed, not
 * another retry.
 *
 * @param {string} url
 * @param {{
 *   fetch?: typeof fetch,
 *   cacheDir?: string,
 *   refetch?: boolean,
 *   now?: Date,
 *   fetchBoard?: (url: string, options: object) => Promise<{ text: string|null, status?: number, salary?: { min: number|null, max: number|null }|null, salarySource?: string|null, posted?: string|null }>
 * }} [options]
 * @returns {Promise<JdReadResult>}
 */
export async function readJd(url, options = {}) {
  const get = options.fetch || globalThis.fetch.bind(globalThis);
  const now = options.now || new Date();
  const policy = hostPolicy(url);
  if (policy === 'blocked-by-policy') return emptyResult('blocked-by-policy');
  if (policy === 'board-404') return emptyResult('board-404', { closed: true });

  const { boardRef } = loadFit();

  /* 1. greenhouse / ashby / lever, unchanged in what they request. */
  if (options.fetchBoard) {
    try {
      const board = await options.fetchBoard(url, options);
      if (board && (board.status === 404 || board.status === 410)) {
        return emptyResult('board-404', { closed: true, via: 'board-api' });
      }
      if (board && board.text && board.text.length > 100) {
        const prose = salaryFromText(board.text);
        const picked = pickSalary({
          ashby: board.salarySource === 'ashby:compensation' ? board.salary : null,
          jsonld: null,
          prose: board.salarySource === 'ashby:compensation' ? null : (board.salary || prose)
        });
        /* When the board fetch already named a source, keep it -- Ashby
           must not be relabelled posting:page just because the description
           also has a number. */
        const source = board.salary && (board.salary.min != null || board.salary.max != null)
          ? (board.salarySource || picked.source)
          : picked.source;
        const salary = board.salary && (board.salary.min != null || board.salary.max != null)
          ? board.salary
          : (picked.min != null || picked.max != null ? { min: picked.min, max: picked.max } : null);
        return {
          text: board.text,
          outcome: 'read',
          salary,
          salarySource: salary ? source : null,
          posted: board.posted || null,
          validThrough: null,
          closed: false,
          via: 'board-api'
        };
      }
    } catch {
      /* fall through -- a board API blip must not skip JSON-LD on a
         greenhouse URL whose page still has the posting. */
    }
  } else if (boardRef(url)) {
    try {
      const { fetchBoardJd } = loadFit();
      const board = await fetchBoardJd(url, options);
      if (board && (board.status === 404 || board.status === 410)) {
        return emptyResult('board-404', { closed: true, via: 'board-api' });
      }
      if (board && board.text && board.text.length > 100) {
        return {
          text: board.text,
          outcome: 'read',
          salary: board.salary || null,
          salarySource: board.salarySource || null,
          posted: board.posted || null,
          validThrough: null,
          closed: false,
          via: 'board-api'
        };
      }
    } catch {
      /* fall through to later tiers */
    }
  }

  /* 2. Workday CXS. */
  const cxs = workdayCxsUrl(url);
  if (cxs) {
    try {
      const res = await getUrl(get, cxs);
      if (res.status === 404 || res.status === 410) {
        return emptyResult('board-404', { closed: true, via: 'workday-cxs' });
      }
      const info = res.json && res.json.jobPostingInfo;
      const html = info && info.jobDescription ? String(info.jobDescription) : '';
      const text = html ? htmlToText(html) : '';
      if (res.status >= 200 && res.status < 300 && text.length > 100) {
        const posted = info.startDate
          ? clampPostedIso(isoFromUnknown(info.startDate) || String(info.startDate), now)
          : null;
        const prose = salaryFromText(text);
        const picked = pickSalary({ prose });
        return {
          text,
          outcome: 'read',
          salary: picked.min != null || picked.max != null ? { min: picked.min, max: picked.max } : null,
          salarySource: picked.source,
          posted,
          validThrough: info.endDate
            ? clampPostedIso(isoFromUnknown(info.endDate) || String(info.endDate), now)
            : null,
          closed: false,
          via: 'workday-cxs'
        };
      }
    } catch {
      /* 403 tenants (Adobe, Cisco) fall through to JSON-LD / page text */
    }
  }

  /* 3. Himalayas feed. The page is 403; never fetch it. */
  if (hostnameOf(url) === 'himalayas.app') {
    try {
      let jobs = [];
      const companyMatch = String(url).match(/\/companies\/([^/]+)\/jobs\//i);
      if (companyMatch) {
        const searchUrl = `https://himalayas.app/jobs/api/search?company=${encodeURIComponent(companyMatch[1])}`;
        const searchRes = await getUrl(get, searchUrl);
        if (searchRes.json && Array.isArray(searchRes.json.jobs)) jobs = searchRes.json.jobs;
      }
      if (!matchHimalayasJob(jobs, url)) {
        let cursor = null;
        for (let page = 0; page < 40; page++) {
          const browse = new URL('https://himalayas.app/jobs/api');
          browse.searchParams.set('limit', '20');
          if (cursor) browse.searchParams.set('cursor', cursor);
          const browseRes = await getUrl(get, browse.toString());
          const batch = browseRes.json && Array.isArray(browseRes.json.jobs) ? browseRes.json.jobs : [];
          jobs = jobs.concat(batch);
          if (matchHimalayasJob(jobs, url)) break;
          if (!browseRes.json || !browseRes.json.nextCursor) break;
          cursor = browseRes.json.nextCursor;
        }
      }
      const job = matchHimalayasJob(jobs, url);
      if (job) {
        const text = htmlToText(String(job.description || job.excerpt || ''));
        if (text.length > 100) {
          const him = salaryFromHimalayasJob(job);
          const picked = pickSalary({ himalayas: him });
          return {
            text,
            outcome: 'read',
            salary: picked.min != null || picked.max != null ? { min: picked.min, max: picked.max } : null,
            salarySource: picked.source,
            posted: clampPostedIso(isoFromUnknown(job.pubDate), now),
            validThrough: clampPostedIso(isoFromUnknown(job.expiryDate), now),
            closed: false,
            via: 'himalayas'
          };
        }
      }
      return emptyResult('unreadable-host', { via: 'himalayas' });
    } catch {
      return emptyResult('unreadable-host', { via: 'himalayas' });
    }
  }

  /* 4 + 5. One page fetch, JSON-LD first, then readable text. */
  try {
    const page = await getUrl(get, url);
    if (page.status === 404 || page.status === 410) {
      return emptyResult('board-404', { closed: true });
    }
    if (page.status < 200 || page.status >= 300 || !page.text) {
      return emptyResult('unreadable-host');
    }
    const fromLd = fromJsonLdHtml(page.text, now);
    if (fromLd) return fromLd;
    const fromText = fromPageText(page.text);
    if (fromText) return fromText;
    return emptyResult('unreadable-host');
  } catch {
    return emptyResult('unreadable-host');
  }
}
