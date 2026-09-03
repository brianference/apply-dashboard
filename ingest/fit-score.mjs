/**
 * Rank a posting the way Brian actually decides: can he take it, does his
 * record match what it asks for, and could he realistically win it.
 *
 * The number on the dashboard today is `scoreMatch()` -- title words plus a
 * seniority word plus a location word. "Principal Product Manager, AI Platform"
 * scores 100 whether or not the job wants ten years of ads infrastructure. It
 * has never read a job description and has never read Brian's record, so it
 * cannot say anything about fit and must not be presented as if it does.
 *
 * Three separate numbers, because they answer three different questions and
 * averaging them into one hides which is failing. The headline then mixes in
 * a fourth term -- pay as a percentile of published starts -- so a high-pay
 * posting that fits well and that he has a real shot at outranks a lower-pay
 * one with a similar fit. The components stay on the row; only the headline
 * is a blend.
 *
 *   requirements  a GATE, not a score. Salary floor, location, role. A posting
 *                 that fails is not "low ranked", it is off the list.
 *   fit_pct       what the job asks for, against what Brian has actually done.
 *                 Every point cites the requirement line that earned it.
 *   success_pct   whether he could realistically win it: seniority distance,
 *                 hard requirements he does not meet, and whether the
 *                 application can even be submitted.
 *   payTerm       percentile of the published START among the rows being
 *                 scored. Unpriced takes the median. Not a dollars-per-point
 *                 scale -- the same reason resume overlap is calibrated.
 *
 * NOTHING is scored without its source. A posting whose description could not
 * be fetched gets fit_pct = null, never a guess -- an invented fit number is
 * worse than no number, because it looks earned and nobody re-checks it.
 *
 *   node ingest/fit-score.mjs --limit 40          # report
 *   node ingest/fit-score.mjs --limit 40 --write  # also update D1
 */

import fs from 'node:fs';
import path from 'node:path';
import { isCli, parseArgs } from './cli.mjs';
import { ensurePayColumns } from './pay-columns.mjs';
import { locationEligible, roleEligible } from './location-eligible.mjs';
import { domainSignals } from './domain-eligible.mjs';
import { corpus, resumeText, resumeMatch, calibrate } from './resume-match.mjs';
import {
  BLOCKED_EMPLOYERS,
  employerBlockReason,
  findBlockedEmployer
} from './blocked-employers.mjs';

/* Built once, lazily: the corpus is a pass over every cached description and
   the resume is one file read. */
let CORPUS = null, RESUME = null;
function corpusOnce() { if (!CORPUS) CORPUS = corpus(); return CORPUS; }
function resumeOnce() { if (RESUME === null) RESUME = resumeText() || false; return RESUME || null; }

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const CACHE = path.join(ROOT, 'ingest', 'out', 'jd-cache');
const FLOOR = 180000;
const SECOND_TIER = 160000;
/* A published START below this fails, however high the top of the range goes.
   Brian set it at $120k on 2026-08-27, raised it to $165k the same day on
   seeing Liberty Mutual at $125k-$201k pass, then settled on $160k. A band is
   an offer conversation that opens at its bottom, and the top is the number a
   company almost never pays. Exactly $160k passes; below it does not. */
const FLOOR_START = 160000;

/**
 * Published start as a number. Strips `$` and thousands separators so
 * `"180,000"` and `"$180,000"` are $180k. A negative or non-finite value
 * is unknown, never a published figure -- do not invent a band.
 *
 * Failing inputs: `{salary_min:-1}` must not count as published;
 * `{salary_min:"180,000"}` must not fall through to unknown.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
/**
 * Which blocked employer, if any, this company is -- and why.
 * The list, the normalising and the reason wording live in
 * ./blocked-employers.mjs; this is the shape the gate and the tests use.
 *
 * @param {string|null|undefined} company
 * @returns {{name: string, reason: string}|null}
 */
export function blockedEmployer(company) {
  const entry = findBlockedEmployer(company);
  return entry ? { name: entry.name, reason: entry.reason } : null;
}

export function parsePayStart(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return raw;
  }
  const n = Number(String(raw).replace(/[$,]/g, '').trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Which pay lane a posting belongs to. Decided on the published START only:
 * a top figure with no start is unknown, not confirmed, matching the gate
 * rule that a range whose start is below FLOOR_START fails however high
 * its top goes.
 *
 * @param {Record<string, any>} job
 * @returns {1|2|3|null} 1 = confirmed at or above FLOOR, 3 = confirmed
 *   second lane (SECOND_TIER up to FLOOR), 2 = unpublished start, null =
 *   start below FLOOR_START (already fails the gate)
 */
export function payTier(job) {
  /* Failing inputs: {salary_min:-1} is unknown, not a published figure;
     {salary_min:"180,000"} and {salary_min:"$180,000"} are $180k. */
  const start = parsePayStart(job && job.salary_min);
  if (start == null || start === 0) return 2;
  if (start >= FLOOR) return 1;
  if (start >= SECOND_TIER && start < FLOOR) return 3;
  if (start > 0 && start < FLOOR_START) return null;
  return 2;
}

/**
 * Best-match order: pay tier first (1, then 2, then 3; missing last), then
 * rank_pct descending, then the keyword match_pct as a last resort.
 *
 * @param {{pay_tier?: number|null, rank_pct?: number|null, match_pct?: number|null}} a
 * @param {{pay_tier?: number|null, rank_pct?: number|null, match_pct?: number|null}} b
 * @returns {number}
 */
export function compareMatchSort(a, b) {
  const tierOf = (row) => {
    const t = Number(row && row.pay_tier);
    return t === 1 || t === 2 || t === 3 ? t : 99;
  };
  const dTier = tierOf(a) - tierOf(b);
  if (dTier) return dTier;
  const score = (row) => Number(row.rank_pct != null ? row.rank_pct : row.match_pct) || 0;
  return score(b) - score(a);
}

/* ------------------------------------------------------------------ *
 * Brian's evidence. Every phrase below is drawn from his own words in
 * apply/narrative.local.md -- dictated 2026-08-22 -- or from
 * apply-profile.local.json. Nothing here is inferred about him.
 * ------------------------------------------------------------------ */
/* What a product job can ASK FOR, and whether Brian can evidence it.
   The job description sets the DENOMINATOR; his record sets the numerator.
   The first version of this scored earned and available on the same branch, so
   fit was 100% for anything whose description mentioned "AI" -- Amplitude
   measured 100 and that impossible value is what exposed it. A fit score that
   cannot come out low is not a measurement.

   `has` is a statement about Brian, taken from apply/narrative.local.md
   (dictated by him 2026-08-22) and apply-profile.local.json. It is NEVER
   derived from the job description. Where he has no evidence, `has` is false
   and the concept counts against him -- that is the whole point. */
export const CONCEPTS = [
  { id: 'ai-llm', weight: 12, has: true, strength: 1.0,
    source: '19 Claude skills published firm-wide; Enterprise AI Champions; builds with Claude Code, Cursor, Figma Make daily',
    re: /\b(ai|a\.i\.|ml|machine learning|llm|genai|generative|agentic|agents?|prompt\w*|copilot|rag|inference)\b/i },
  { id: 'equity-comp', weight: 10, has: true, strength: 1.0,
    source: 'AwardTraq: relative TSR, percentile rankings, ASC 718 reporting',
    re: /\b(equity|stock compensation|asc ?718|tsr|total shareholder return|cap table|rsus?|vesting|compensation planning)\b/i },
  { id: 'payments-fintech', weight: 10, has: true, strength: 0.55,
    source: 'American Express MYCA Payments',
    re: /\b(payments?|checkout|billing|transactions?|fintech|financial services|banking|lending|credit|treasury)\b/i },
  { id: 'b2b-enterprise', weight: 9, has: true, strength: 0.95,
    source: 'Fortune 50 down to newly public clients; Customer Portal; enterprise reporting',
    re: /\b(b2b|enterprise|saas|business customers|client portal|customer portal|self-?service)\b/i },
  { id: 'zero-to-one', weight: 9, has: true, strength: 0.85,
    source: 'Customer Portal and Forecasting taken from concept to high-fidelity prototype himself',
    re: /\b(0 ?- ?1|zero to one|0 to 1|greenfield|new product|from scratch|early stage|prototyp\w+|discovery)\b/i },
  { id: 'analytics-experimentation', weight: 8, has: true, strength: 0.7,
    source: 'PostHog NPS survey from proof of concept to production; first CSAT baseline at the firm',
    re: /\b(analytics|experimentation|a\/b test\w*|posthog|amplitude|mixpanel|nps|csat|instrumentation|telemetry)\b/i },
  { id: 'leadership', weight: 8, has: true, strength: 0.75,
    source: 'Stood up the Product function at Equity Methods; trained 100\+ employees; five-part training series',
    re: /\b(stood up|build (out )?the team|hiring|mentor\w*|lead a team|cross-?functional|stakeholder|influence without authority)\b/i },
  { id: 'design-ux', weight: 6, has: true, strength: 0.5,
    source: 'Interviewed and trained the UX designer; works in Figma Make daily',
    re: /\b(figma|design system|user research|usability|ux partner)\b/i },
  { id: 'reporting-data-viz', weight: 7, has: true, strength: 0.9,
    source: 'AwardTraq narrative, graphical and tabular reports',
    re: /\b(reporting|dashboards?|data visuali[sz]ation|charts?|bi tools?)\b/i },

  /* Asked for by real postings, and NOT in his record. These are what make a
     low fit score possible, and each one is a genuine reason a recruiter would
     pass him over for someone who has it. */
  { id: 'adtech', weight: 9, has: false, source: '',
    re: /\b(ad ?tech|advertis\w+|dsp|programmatic|campaign manager|ad server|brand safety)\b/i },
  { id: 'healthcare-clinical', weight: 9, has: false, source: '',
    re: /\b(clinical|ehr|emr|hipaa|patient|provider network|payer|claims adjudication)\b/i },
  { id: 'gaming', weight: 8, has: false, source: '',
    re: /\b(gaming|game design|player experience|live ?ops|matchmaking)\b/i },
  { id: 'hardware-robotics', weight: 9, has: false, source: '',
    re: /\b(hardware|firmware|robotics|semiconductor|autonomous vehicle|lidar|embedded)\b/i },
  { id: 'supply-chain', weight: 8, has: false, source: '',
    re: /\b(supply chain|logistics|warehouse|fulfil?lment|freight|inventory management)\b/i },
  { id: 'security-product', weight: 9, has: false, source: '',
    re: /\b(threat|malware|siem|vulnerabilit\w+|penetration test|zero trust|endpoint protection)\b/i },
  { id: 'devtools-infra', weight: 8, has: false, source: '',
    re: /\b(developer tools?|developer experience|ci\/cd|kubernetes|observability platform|sre)\b/i },
  { id: 'marketplace-consumer', weight: 8, has: false, source: '',
    re: /\b(marketplace|two-?sided|consumer social|creator economy|gig economy)\b/i },
  { id: 'mobile', weight: 7, has: false, source: '',
    re: /\b(ios|android|mobile app|react native|app store)\b/i },
  { id: 'growth-acquisition', weight: 7, has: false, source: '',
    re: /\b(growth loops?|user acquisition|paid acquisition|seo|virality|funnel optimi[sz]ation)\b/i },
  { id: 'ecommerce-retail', weight: 7, has: false, source: '',
    re: /\b(e-?commerce|retail|merchandising|cart|storefront)\b/i },
  { id: 'ml-infra', weight: 8, has: false, source: '',
    re: /\b(ml ?ops|model training|feature store|gpu cluster|model serving|fine-?tun\w+)\b/i }
];

/** Requirements a posting can state that Brian does not meet. */
export const HARD_BLOCKERS = [
  { id: 'clearance', why: 'security clearance', re: /\b(security clearance|ts\/sci|top secret|public trust|polygraph)\b/i },
  { id: 'onsite', why: 'onsite or hybrid attendance required', re: /\b(\d+ days? (a|per) week (in|on)[- ]?(the )?(office|site)|onsite \d+ days|hybrid schedule requires)\b/i },
  { id: 'phd', why: 'PhD required', re: /\bph\.?d\.? (is )?(required|preferred and required)\b/i },
  { id: 'relocate', why: 'relocation required', re: /\bmust relocate\b/i }
];

/**
 * Years of experience the posting demands, if it states a number.
 * @param {string} text
 * @returns {number|null}
 */
export function yearsRequired(text) {
  const m = String(text || '').match(/(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?years?[^.]{0,40}?(?:experience|product)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n < 30 ? n : null;
}

/** Seniority the posting is pitched at. */
export function seniorityOf(title) {
  const t = String(title || '');
  if (/\b(vp|vice president|chief|cpo|head of)\b/i.test(t)) return 5;
  if (/\bdirector\b/i.test(t)) return 4;
  if (/\b(principal|staff|group product manager|gpm)\b/i.test(t)) return 3;
  if (/\b(senior|sr\.?|lead)\b/i.test(t)) return 2;
  if (/\b(associate|junior|jr\.?|entry|intern|new grad)\b/i.test(t)) return 0;
  return 1;
}

/* Brian: "Two years with the Product Manager title, plus additional years
   performing the role as an Engineering Manager." Senior is the centre of mass;
   Principal/Staff is a genuine stretch; Director+ is a long shot; Associate is
   a step down he would not take. */
const BRIAN_LEVEL = 2;

/**
 * Is this a security product, whatever the title says?
 *
 * Some phrases settle it on their own. Delinea's own posting opens "a pioneer
 * in securing human and machine identities ... Identity Security Platform ...
 * respond to threats in real-time", and its two roles ranked 1st and 4th
 * because the titles ("Senior Product Manager - Platform") say nothing and a
 * frequency threshold of three never tripped -- the description used each
 * security word only once. A decisive phrase needs no repetition; a vague one
 * needs several.
 *
 * @param {string} jd
 * @returns {{ruled: boolean, why: string}}
 */
export function securitySignals(jd) {
  const t = String(jd || '');
  const DECISIVE = /\bidentity security\b|\bsecurity platform\b|securing (human|machine|digital)[^.]{0,30}identit|privileged access|\bpam\b|access management|\bsiem\b|zero trust|endpoint protection|threat detection|vulnerability management|security posture|\bsoc ?2? (analyst|team)\b|cybersecurity (company|platform|product)/i;
  const d = t.match(DECISIVE);
  if (d) return { ruled: true, why: `"${d[0].trim()}"` };
  const WEAK = /\b(threat|malware|vulnerabilit\w+|infosec|\biam\b|cybersecurity|penetration test)\b/gi;
  const w = t.match(WEAK) || [];
  if (w.length >= 4) return { ruled: true, why: `${w.length} security terms` };
  return { ruled: false, why: '' };
}

/**
 * The hard gate. A posting that fails is not ranked -- it is off the list.
 * @param {Record<string, any>} job
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function requirementsGate(job, jd, options = {}) {
  const reasons = [];
  /* Checked before anything else: an employer he has ruled out is not a
     scoring question. Brian, 2026-08-31: Coinbase caps how many times you may
     apply and does not reply. */
  /* options.blockedEmployers lets a test supply its own list. Without it the
     'a blocked employer fails' check would also pass on a gate that rejects
     everything, so the control is the same row with an EMPTY list. */
  const blockList = options.blockedEmployers || BLOCKED_EMPLOYERS;
  const blockedCo = findBlockedEmployer(job && job.company, blockList);
  if (blockedCo) reasons.push(employerBlockReason(blockedCo));
  /* The role rule reads the TITLE only, and a security product does not have to
     say so in its title. Measured 2026-08-26: Delinea "Senior Product Manager -
     Platform" and "... Non-Human Identity" ranked 1st and 4th -- Delinea is a
     privileged-access-management company, which is exactly the category Brian
     ruled out. With the description in hand the gate can see what the title
     hides. Three or more hits, so one passing mention of "vulnerability" in a
     benefits paragraph cannot rule a job out. */
  if (jd) {
    const sec = securitySignals(jd);
    if (sec.ruled) reasons.push(`role: security product - ${sec.why}`);
  }
  /* Healthcare, construction, hardware, clearance and risk-compliance are
     decided here. Healthcare and hardware read the DESCRIPTION: SmarterDx's
     "Group Product Manager, SmarterDenials" sat at 70 percent because
     neither its title nor its company name says health anywhere, and
     vCluster Labs' "Staff Product Manager (vMetal)" sat at 59 percent the
     same way. Risk-compliance is title-first -- searching the description
     for "compliance" is the HIPAA/Vanta trap. */
  const domain = domainSignals(job, jd);
  if (domain.ruled) reasons.push(`domain: ${domain.domain} - ${domain.why}`);
  const role = roleEligible(job.title);
  if (!role.ok) reasons.push(`role: ${role.why}`);
  const loc = locationEligible(job.work_type, job.title);
  if (!loc.ok) reasons.push(`location: ${loc.why}`);
  /* The bottom of the band is checked before the top. An unpublished start is
     unknown and passes; a published one at or below the floor does not. */
  const bottom = parsePayStart(job.salary_min) || 0;
  if (bottom > 0 && bottom < FLOOR_START) {
    reasons.push(`salary: the range starts at $${Math.round(bottom / 1000)}k, below the $${FLOOR_START / 1000}k start floor`);
  }
  /* An unpublished salary is UNKNOWN, not low. Most postings publish nothing
     and dropping them would empty the list. Only a PUBLISHED figure can fail.

     The TOP no longer rules anything out. Brian, 2026-08-31: $160-180k is a
     second lane, not a reject, and this rule contradicted that -- a band
     published as $165k-$175k was dropped for topping out under $180k, so the
     `Confirmed $160-180k` lane could only ever hold ranges that ALSO reached
     $180k+. The lane carries that distinction now (payTier returns 3), and the
     gate decides only whether the money is under his floor at all.

     A top with no start published is the one case the start rule cannot see:
     $150k with no floor stated is a published band under the floor, not an
     unknown one, so it still fails. */
  const top = parsePayStart(job.salary_max) || 0;
  if (bottom === 0 && top > 0 && top < FLOOR_START) {
    reasons.push(`salary: publishes $${Math.round(top / 1000)}k and no start, below the $${FLOOR_START / 1000}k floor`);
  }
  /* The domain is returned separately from the prose reason so the list can
     offer it as a switch. A signed-in account can turn these back on, and a
     string it has to parse out of a sentence is not something to switch on. */
  return { ok: reasons.length === 0, reasons, excludedDomain: domain.ruled ? domain.domain : null };
}

/**
 * How well Brian's record matches what this job asks for.
 * Returns null when the description could not be read -- never a guess.
 * @param {string|null} jd
 * @returns {{pct: number, hits: string[], misses: string[]}|null}
 */
export function requirementsSection(jd) {
  const t = String(jd || '');
  /* Score what the job REQUIRES, not the company blurb. Measured 2026-08-26:
     scoring the whole description put 20 of 35 real postings at exactly 100%,
     because "AI", "cross-functional", "SaaS" and "dashboards" appear in the
     marketing paragraphs of nearly every product posting. The qualifications
     section is where a recruiter's actual screen lives. */
  const m = t.match(/(what (you'?ll |we )?(need|bring|are looking for)|requirements|qualifications|about you|who you are|basic qualifications|minimum qualifications)[:\s]([\s\S]{200,4000})/i);
  return m ? m[3] : null;
}

export function fitScore(jd) {
  if (!jd || jd.length < 300) return null;
  const reqs = requirementsSection(jd);
  const text = reqs || jd;
  const hits = [];
  const gaps = [];
  let earned = 0;
  let asked = 0;
  let askedCount = 0;
  for (const c of CONCEPTS) {
    /* Emphasis, not mere presence. One passing mention of "payments" in a
       company blurb is not the same requirement as a section that returns to it
       four times, and treating them alike is what pinned the score at 100. */
    const found = String(text).match(new RegExp(c.re.source, 'gi'));
    if (!found) continue;
    const emphasis = Math.min(3, found.length);       // 1..3
    const w = c.weight * emphasis;
    asked += w;
    askedCount += 1;
    /* strength is how CURRENT and DEEP his evidence is, not merely whether he
       has touched the area. American Express MYCA Payments was a prior role and
       scores 0.55; the Claude skills library is what he does now and scores 1.0.
       Binary has/has-not put 17 of 51 real postings at exactly 100%. */
    if (c.has) { earned += w * c.strength; hits.push(`${c.id} x${emphasis} @${c.strength} - ${c.source}`); }
    else gaps.push(`${c.id} x${emphasis}`);
  }
  if (askedCount < 3) return null;
  return {
    pct: Math.round((earned / asked) * 100),
    hits, gaps, askedCount,
    scoredOn: reqs ? 'requirements section' : 'whole description'
  };
}

/**
 * Could he realistically win it?
 * @param {Record<string, any>} job
 * @param {string|null} jd
 * @returns {{pct: number, reasons: string[]}}
 */
export function successScore(job, jd) {
  const reasons = [];
  let pct = 70;                        // a matched, submittable, level-appropriate role

  const gap = seniorityOf(job.title) - BRIAN_LEVEL;
  if (gap <= -2) { pct -= 45; reasons.push('a step down in level'); }
  else if (gap === -1) { pct -= 10; reasons.push('slightly below his level'); }
  else if (gap === 1) { pct -= 12; reasons.push('a stretch: principal/staff'); }
  else if (gap === 2) { pct -= 28; reasons.push('a big stretch: director'); }
  else if (gap >= 3) { pct -= 45; reasons.push('VP or above'); }

  if (jd) {
    const yrs = yearsRequired(jd);
    /* Brian has two years with the PM title. A posting asking for ten screens
       him out on paper however good the domain match is, and pretending
       otherwise is how a list fills up with jobs that never reply. */
    if (yrs !== null) {
      if (yrs >= 10) { pct -= 25; reasons.push(`asks for ${yrs}+ years`); }
      else if (yrs >= 7) { pct -= 12; reasons.push(`asks for ${yrs}+ years`); }
      else if (yrs <= 5) { pct += 5; reasons.push(`asks for only ${yrs}+ years`); }
    }
    for (const b of HARD_BLOCKERS) {
      if (b.re.test(jd)) { pct -= 40; reasons.push(`blocker: ${b.why}`); }
    }
  } else {
    pct -= 5;
    reasons.push('description unread, so requirements are unknown');
  }

  /* A job the runner cannot submit to is not a job he is likely to get. This is
     the most honest signal in the whole score: 64 postings sit behind an
     emailed code and 32 behind a captcha, and none of them are applications
     until a human finishes them. */
  const wall = String(job.blocked_reason || '');
  if (/posting-closed|no-submit-button|wall|needs-account/.test(wall)) { pct -= 35; reasons.push(`cannot submit: ${wall}`); }
  else if (/captcha|needs-email-code|employer-rate-limit/.test(wall)) { pct -= 12; reasons.push(`needs a human step: ${wall}`); }

  return { pct: Math.max(0, Math.min(100, pct)), reasons };
}

/* ------------------------------------------------------------------ *
 * Job description fetching. Only boards with a public API are read; an
 * unreadable posting stays null rather than being guessed at.
 * ------------------------------------------------------------------ */

/** @param {string} url @returns {{ats: string, token: string, id: string}|null} */
export function boardRef(url) {
  const u = String(url || '');
  let m = u.match(/job-boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i)
    || u.match(/boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i);
  if (m) return { ats: 'greenhouse', token: m[1], id: m[2] };
  /* A company's own careers page fronting Greenhouse keeps the job id in
     ?gh_jid= but names no board. Measured 2026-08-26: 252 queued rows were
     unranked and 60+ of them were these -- Stripe, Brex, Samsara, Pinterest,
     Databricks, Datadog, Coinbase, Elastic, MongoDB. The board token is not in
     the URL, so it is resolved from an id -> board index built once from the
     boards already listed in companies.json. */
  m = u.match(/[?&]gh_jid=(\d+)/i);
  if (m) return { ats: 'greenhouse', token: null, id: m[1] };
  m = u.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i);
  if (m) return { ats: 'ashby', token: m[1], id: m[2] };
  m = u.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/i);
  if (m) return { ats: 'lever', token: m[1], id: m[2] };
  return null;
}

/* Named entities the salary extractor and the rest of ranking actually meet
   in board HTML. mdash/ndash become a hyphen because salaryFromText reads
   `-`, `–` and `—` as range separators but does not read the literal entity
   `&mdash;` -- MongoDB job 8143805 published $126,000-$248,000 and came back
   unpriced for exactly that reason. */
const NAMED_ENTITIES = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '-',
  ndash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"'
};

/* Greenhouse returns its pay-transparency block double-escaped, so one pass
   turns `&amp;lt;` into `&lt;` and the next turns that into a tag. Eight is
   more than any real posting needs; without a cap a pathological input that
   kept reproducing entities would spin until the runner was killed. */
export const STRIP_MAX_PASSES = 8;

/* Closing these (and br in any form) mark a block boundary. Replacing the
   tag with a space, then collapsing whitespace, glues the last word of one
   block to the first word of the next: Instacart's <h2>About the Job</h2>
   next to <h2>Site Theming</h2> became "Job Site" and the construction
   rule's `job ?site` matched a pair that is not adjacent on the page.
   A period survives that collapse; a newline does not. Inline tags stay
   a space so <span>$126,000</span><span>-</span><span>$248,000</span>
   remains one range. The regexes are written inside strip() so a /g
   lastIndex cannot leak across calls. */
const BLOCK_SEPARATOR = '.';

/**
 * One decode pass. `&amp;` is last so `&amp;lt;` becomes `&lt;` rather than
 * `<` in the same pass -- otherwise the loop sees no entities, thinks it is
 * finished, and leaves the newly created tags in the text.
 *
 * @param {string} html
 * @returns {string}
 */
export function decodeHtmlEntities(html) {
  let s = String(html || '');
  s = s.replace(/&([a-z]+);/gi, (full, name) => {
    const key = String(name).toLowerCase();
    if (key === 'amp') return full;
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)
      ? NAMED_ENTITIES[key]
      : full;
  });
  s = s.replace(/&#(\d+);/g, (full, digits) => fromCharCode(Number(digits), full));
  s = s.replace(/&#x([0-9a-f]+);/gi, (full, hex) => fromCharCode(parseInt(hex, 16), full));
  s = s.replace(/&amp;/gi, '&');
  return s;
}

/**
 * @param {number} code
 * @param {string} fallback
 * @returns {string}
 */
function fromCharCode(code, fallback) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  /* Numeric mdash (8212, 0x2014) and ndash (8211, 0x2013) become a hyphen
     for the same reason the named forms do: the extractor has to see a
     separator it already knows. */
  if (code === 0x2014 || code === 0x2013) return '-';
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * Greenhouse HTML to the plain text ranking and salary extraction read.
 *
 * The previous version stripped real tags once and replaced every named
 * entity with a space. Greenhouse double-escapes the pay block, so the real
 * tags came off, the escaped ones survived, and `$126,000` sat 91 characters
 * away from `$248,000` with `&lt;span&gt;` and `&mdash;` between them.
 * salaryFromText needs the figures adjacent with a dash (or "to") in
 * between, so it returned {min:null,max:null}. A posting that publishes a
 * band must never end up on the list with no band: the pay lane treats
 * "no band" as unknown, not low, and floats the row above priced postings
 * it should sit below.
 *
 * Decode and strip until the text stops changing, so a second layer of
 * escaping cannot hide a published range.
 *
 * @param {string} html
 * @returns {string}
 */
export function strip(html) {
  let text = String(html || '');
  for (let i = 0; i < STRIP_MAX_PASSES; i++) {
    const prev = text;
    text = decodeHtmlEntities(text)
      .replace(/<\/(?:p|div|li|ul|ol|h[1-6]|tr|td|section|header|footer|article)\b[^>]*>/gi, BLOCK_SEPARATOR)
      .replace(/<br\b[^>]*>/gi, BLOCK_SEPARATOR)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === prev) break;
  }
  return text;
}

/**
 * Cache file name fetchJd writes. Shared so the salary audit reads the same
 * file the ranking pass used, not a parallel guess at the board token.
 *
 * @param {{ats: string, token: string, id: string}|null|undefined} ref
 * @returns {string|null}
 */
export function jdCacheFileName(ref) {
  if (!ref || !ref.ats || !ref.token || !ref.id) return null;
  return `${ref.ats}-${ref.token}-${ref.id}`.replace(/[^a-z0-9-]/gi, '_') + '.txt';
}

/**
 * Sidecar next to the description cache, holding Ashby's structured
 * compensation object. The description never contains the band; without
 * this file the salary audit would pass every Ashby row whose feed
 * published pay.
 *
 * @param {{ats: string, token: string, id: string}|null|undefined} ref
 * @returns {string|null}
 */
export function ashbyCompensationCacheFileName(ref) {
  if (!ref || ref.ats !== 'ashby') return null;
  const name = jdCacheFileName(ref);
  return name ? name.replace(/\.txt$/, '.compensation.json') : null;
}

/** id -> board token, built once from every Greenhouse board we already know. */
let GH_INDEX = null;
/** Six hours is under the twelve between scheduled runs, so a scheduled run
    always rebuilds and an ad-hoc local run reuses at most one cycle's index. */
export const GH_INDEX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Is a cached board index still usable?
 *
 * Pulled out as a pure function so the expiry can be tested without a network
 * call. An unreadable or future mtime is treated as stale: rebuilding costs a
 * minute, and trusting a bad timestamp cost every Greenhouse posting published
 * over seven days.
 *
 * @param {number} mtimeMs
 * @param {number} nowMs
 * @param {number} [maxAgeMs]
 * @returns {boolean}
 */
export function indexIsFresh(mtimeMs, nowMs, maxAgeMs = GH_INDEX_MAX_AGE_MS) {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs)) return false;
  const age = nowMs - mtimeMs;
  if (age < 0) return false;
  return age < maxAgeMs;
}

async function greenhouseIndex() {
  if (GH_INDEX) return GH_INDEX;
  const idxFile = path.join(CACHE, 'gh-index.json');
  fs.mkdirSync(CACHE, { recursive: true });
  /* The index maps a Greenhouse job id to the board it lives on, and it was
     written once and reused forever. On this machine the file was built on
     2026-08-26 and still in use on 2026-09-02, so EVERY Greenhouse posting
     published in between resolved to no board at all: fetchJd returned null,
     the row got no description, and with no description there is no ranking
     component, no published salary and no domain rule. MongoDB's Client
     Libraries posting sat at 76 percent with its $126k-$248k band lost for
     exactly this reason, and the salary audit could not see it either, because
     an unreadable row has nothing to audit.

     CI never hit it: ingest/out is gitignored, so a runner rebuilds the index
     every run. Only a local run could go stale, which is the worst version of
     this bug -- it is invisible where it is checked and wrong where it is used.

     Six hours is under the twelve between scheduled runs, so a scheduled run
     always rebuilds and an ad-hoc local run reuses at most one cycle's index. */
  if (fs.existsSync(idxFile)) {
    let fresh = false;
    try { fresh = indexIsFresh(fs.statSync(idxFile).mtimeMs, Date.now()); } catch { fresh = false; }
    if (fresh) {
      try { GH_INDEX = JSON.parse(fs.readFileSync(idxFile, 'utf8')); return GH_INDEX; } catch { /* rebuild */ }
    }
  }
  const companies = JSON.parse(fs.readFileSync(path.join(ROOT, 'ingest', 'companies.json'), 'utf8'));
  const idx = {};
  const tokens = (companies.greenhouse || []).map(c => c.token);
  /* Four at a time: this is somebody else's public API and a burst of 72 is
     rude, not clever. */
  for (let i = 0; i < tokens.length; i += 4) {
    await Promise.all(tokens.slice(i, i + 4).map(async (t) => {
      try {
        const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs`);
        if (!r.ok) return;
        for (const j of (await r.json()).jobs || []) idx[String(j.id)] = t;
      } catch { /* one unreachable board must not fail the index */ }
    }));
  }
  GH_INDEX = idx;
  fs.writeFileSync(idxFile, JSON.stringify(idx));
  return idx;
}

/**
 * Fetch a posting's description, through the board API the URL names.
 *
 * @param {string} url
 * @param {{refetch?: boolean}} [options] refetch: true skips the on-disk
 *   cache. Recover uses it because files written by the old decoder replaced
 *   `&mdash;` with a space, and re-decoding cannot put the separator back.
 * @returns {Promise<string|null>}
 */
export async function fetchJd(url, options = {}) {
  const ref = boardRef(url);
  if (!ref) return null;
  if (ref.ats === 'greenhouse' && !ref.token) {
    const idx = await greenhouseIndex();
    ref.token = idx[ref.id] || null;
    if (!ref.token) return null;          // unknown board: unread, never guessed
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const cacheFile = path.join(CACHE, jdCacheFileName(ref));
  const compensationName = ashbyCompensationCacheFileName(ref);
  const compensationFile = compensationName ? path.join(CACHE, compensationName) : null;
  /* Cache hits still run through strip(). Files written before the decoder
     loop left `&lt;span&gt;` and `&mdash;` in the text, and salaryFromText
     then reported no band on a posting that published one. Re-decoding is
     what makes those files usable; refetch is for files the old decoder
     already turned the separator into a space, which no amount of decoding
     can put back.
     An Ashby description cache without its compensation sidecar is not a
     hit: the band lives in the feed, not the text, and reusing the old
     file would keep losing it. */
  const haveDescription = fs.existsSync(cacheFile);
  const haveCompensation = ref.ats !== 'ashby' || (compensationFile && fs.existsSync(compensationFile));
  if (!options.refetch && haveDescription && haveCompensation) {
    const cached = fs.readFileSync(cacheFile, 'utf8');
    const text = strip(cached);
    if (text !== cached) {
      try { fs.writeFileSync(cacheFile, text, 'utf8'); } catch { /* cache is a shortcut */ }
    }
    return text;
  }
  let text = null;
  try {
    if (ref.ats === 'greenhouse') {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${ref.token}/jobs/${ref.id}?content=true`);
      if (r.ok) text = strip((await r.json()).content);
    } else if (ref.ats === 'ashby') {
      const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${ref.token}?includeCompensation=true`);
      if (r.ok) {
        const payload = await r.json();
        const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
        const j = jobs.find((x) => x && String(x.id) === String(ref.id));
        if (compensationFile) {
          try {
            fs.writeFileSync(
              compensationFile,
              JSON.stringify({ compensation: j && j.compensation ? j.compensation : null }),
              'utf8'
            );
          } catch { /* cache is a shortcut */ }
        }
        text = j ? (j.descriptionPlain || strip(j.descriptionHtml)) : null;
      }
    } else if (ref.ats === 'lever') {
      const r = await fetch(`https://api.lever.co/v0/postings/${ref.token}/${ref.id}`);
      if (r.ok) {
        const j = await r.json();
        text = [strip(j.descriptionPlain || j.description),
          ...(j.lists || []).map(l => `${l.text} ${strip(l.content)}`)].join(' ');
      }
    }
  } catch {
    if (haveDescription) {
      return strip(fs.readFileSync(cacheFile, 'utf8'));
    }
    return null;
  }
  if (text && text.length > 100) { fs.writeFileSync(cacheFile, text, 'utf8'); return text; }
  if (haveDescription) return strip(fs.readFileSync(cacheFile, 'utf8'));
  return null;
}

/**
 * Domains Brian has not built his career in.
 *
 * "Staff Product Manager, Marketing Pro" scored 76 and sat near the top of the
 * list. It is a genuine product-management role, so excluding it would be
 * wrong, and the resume overlap is real because the PRODUCT vocabulary matches
 * regardless of what the product is for. What the score had no way to express
 * is that the DOMAIN is one he has not worked in, so a strong match on
 * "roadmap", "discovery" and "stakeholders" reads as a strong fit for a job he
 * would not take.
 *
 * This list holds only what Brian has actually said. He named marketing on
 * 2026-08-29. Nothing else is in here, because a domain he has not ruled out is
 * not a domain to penalise on my guess.
 */
const OFF_FOCUS = [
  /* Word boundaries are real \b escapes. The first version of this line went
     through a shell heredoc, which turned every one of them into a literal
     backspace character, and the pattern then matched nothing at all: the
     penalty was in the code, the reason was wired into the row, and the score
     never moved. It read as implemented. Running the matcher against the very
     title that prompted it is what caught it. */
  { name: 'marketing', pattern: /\bmarketing\b|\bdemand gen(eration)?\b|\bmartech\b|\bcampaign management\b/i }
];

/**
 * How many points an off-focus domain costs.
 *
 * Large enough to move a posting out of the band a person reads first, small
 * enough that an otherwise excellent match is still visible rather than buried:
 * the role that prompted this drops from 76 to 51, below every posting in his
 * actual domain and above the noise.
 */
const OFF_FOCUS_PENALTY = 25;

/**
 * Which off-focus domain a posting belongs to, by title.
 *
 * The TITLE only, deliberately. Nearly every product description mentions
 * marketing somewhere - a stakeholder, an adjacent team, a go-to-market
 * paragraph - so matching the description would penalise most of the queue.
 * The title is where a product's domain is actually declared.
 *
 * @param {string} title
 * @returns {{name: string}|null}
 */
export function offFocusDomain(title) {
  const t = String(title || '');
  for (const domain of OFF_FOCUS) {
    if (domain.pattern.test(t)) return { name: domain.name };
  }
  return null;
}

/* Headline weights. Named so a future edit that makes them sum to 0.95
   fails a test instead of silently compressing every score. Pay is a
   percentile, not dollars, for the same reason resume overlap is
   calibrated: a raw $170k cannot be averaged with a 45-94 fit score. */
export const RANK_FIT_WEIGHT = 0.40;
export const RANK_SUCCESS_WEIGHT = 0.35;
export const RANK_PAY_WEIGHT = 0.25;
/* Unread descriptions keep this weight on success alone. Mixing pay into
   only that branch would be a second change with its own behaviour. */
export const RANK_UNREAD_SUCCESS_WEIGHT = 0.6;

/**
 * Percentile of a published start among the starts being scored.
 *
 * Same shape as calibrate() in resume-match.mjs: count how many values sit
 * strictly below this one, so a start that equals several others is not
 * counted as beating itself. A raw dollar figure cannot be averaged with a
 * 45-94 fit score; the percentile can.
 *
 * An empty or missing distribution returns 50, never 0. Zero would silently
 * punish every posting, including ones that published nothing. Unknown is
 * average here -- the same principle as unknown-is-not-low in the salary
 * gate.
 *
 * @param {number} start
 * @param {number[]|null|undefined} sortedStarts ascending published starts
 * @returns {number} 0 to 100
 */
export function payPercentile(start, sortedStarts) {
  if (!Array.isArray(sortedStarts) || sortedStarts.length === 0) return 50;
  if (start == null || !Number.isFinite(Number(start))) return 50;
  const n = Number(start);
  let below = 0;
  for (const v of sortedStarts) {
    if (v < n) below++;
    else break;
  }
  return Math.round((below / sortedStarts.length) * 100);
}

/**
 * Sorted published starts from the rows about to be scored. Built once per
 * run so every posting is judged against the same population, not against
 * a distribution that grows as the loop writes.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {number[]}
 */
export function publishedStarts(rows) {
  const starts = [];
  for (const row of rows || []) {
    const start = parsePayStart(row && row.salary_min);
    if (start != null && start > 0) starts.push(start);
  }
  starts.sort((a, b) => a - b);
  return starts;
}

/**
 * The three-term headline. Weights are named constants so a typo shows up
 * as a failed sum rather than a list that all got a bit worse.
 *
 * @param {number} fitPct
 * @param {number} successPct
 * @param {number} payTerm
 * @returns {number}
 */
export function rankBlend(fitPct, successPct, payTerm) {
  return Math.round(
    fitPct * RANK_FIT_WEIGHT
    + successPct * RANK_SUCCESS_WEIGHT
    + payTerm * RANK_PAY_WEIGHT
  );
}

/**
 * Pay component for one row. Unpriced takes the median (50). A missing
 * distribution also returns 50 for every row -- never 0, because zero
 * would silently punish the whole list.
 *
 * I first specified this the other way: unpriced rows kept the old
 * two-term blend, priced rows got diluted by their pay percentile. Against
 * the live queue the top twelve came out almost entirely unpriced
 * (PeopleGrove 77, Jerry.ai 74, Camunda 72). That penalises an employer
 * for publishing a band, which is backwards. Unknown is average here, the
 * same principle as unknown-is-not-low in the salary gate.
 *
 * @param {Record<string, any>} job
 * @param {number[]|null|undefined} payStarts
 * @returns {number}
 */
function payTermFor(job, payStarts) {
  const start = parsePayStart(job && job.salary_min);
  if (start == null || start === 0) return 50;
  return payPercentile(start, payStarts);
}

/**
 * Score one posting end to end.
 *
 * Pay is in the headline as a percentile of published starts, AND still a
 * separate `pay_tier` so Best match can sort confirmed $180k+ first. The
 * lane is the sort; the percentile is the number on the row.
 *
 * `payStarts` is the sorted published starts of the rows being scored,
 * built once per run. A missing or empty distribution degrades to
 * payTerm 50 for every row, not to 0 -- zero would silently punish every
 * posting. The function stays pure and never invents a number.
 *
 * @param {Record<string, any>} job
 * @param {string|null} jd
 * @param {number[]|null|undefined} [payStarts]
 * @returns {{
 *   gate: {ok: boolean, reasons: string[], excludedDomain: string|null},
 *   fit: object|null,
 *   success: {pct: number, reasons: string[]},
 *   rank: number|null,
 *   pay_tier: 1|2|3|null,
 *   offFocus: {name: string}|null,
 *   jdRead: boolean,
 *   payTerm: number,
 *   payStart: number|null
 * }}
 */
export function scoreOne(job, jd, payStarts) {
  const gate = requirementsGate(job, jd);
  const concept = fitScore(jd);
  const success = successScore(job, jd);
  /* The real resume, against this posting's distinctive requirements. The
     CONCEPTS table above is my written summary of Brian; this is his actual
     document. Both are kept: the concepts encode judgement about what a domain
     means, the resume match is evidence that cannot be argued with. */
  const rawResume = resumeMatch(jd, resumeOnce(), corpusOnce());
  /* Raw overlap runs 0-30 on real postings, so it is reported as a PERCENTILE
     against every cached description. Averaging the raw number with a 45-94
     concept score made a strong posting read as a weak one -- Jerry.ai fell
     from 86 to 51 on a resume overlap of 15, which is actually above average. */
  const resume = rawResume ? { ...rawResume, raw: rawResume.pct, pct: calibrate(rawResume.pct) } : null;
  const resumeUsable = resume && resume.pct !== null;
  const fit = concept === null ? null : {
    ...concept,
    conceptPct: concept.pct,
    resumePct: resumeUsable ? resume.pct : null,
    resumeRaw: resume ? resume.raw : null,
    matched: resume ? resume.matched : [],
    missing: resume ? resume.missing : [],
    /* Half and half when both exist. Weighting either one higher would be a
       preference I have no evidence for. */
    pct: resumeUsable ? Math.round(concept.pct * 0.6 + resume.pct * 0.4) : concept.pct
  };
  const parsedStart = parsePayStart(job && job.salary_min);
  const payStart = parsedStart != null && parsedStart > 0 ? parsedStart : null;
  const payTerm = payTermFor(job, payStarts);
  /* The headline is deliberately NOT a two-way average. A posting that fails
     the gate has no headline at all. One whose description was unreadable
     still carries success * 0.6 with no pay term -- adding pay to only that
     branch would be a second change with its own behaviour. Everyone else
     is fit, success, and the pay percentile, priced and unpriced alike. */
  const base = !gate.ok ? null
    : fit === null ? Math.round(success.pct * RANK_UNREAD_SUCCESS_WEIGHT)
      : rankBlend(fit.pct, success.pct, payTerm);
  /* A domain he does not work in costs points rather than the whole posting.
     Applied after the blend, not inside it, so the penalty is visible in the
     reason rather than dissolved into a component score. */
  const offFocus = base === null ? null : offFocusDomain(job && job.title);
  const rank = offFocus ? Math.max(0, base - OFF_FOCUS_PENALTY) : base;
  /* A failed gate clears the tier the same way it clears the rank: the row
     is off the list, not a low-ranked job in a pay lane. */
  const pay_tier = gate.ok ? payTier(job) : null;
  return { gate, fit, success, rank, pay_tier, offFocus, jdRead: !!jd, payTerm, payStart };
}

/**
 * The prose stored in rank_why for one scored row.
 *
 * Pay has to be named here. The percentage on the page carries this string
 * in its hover title, and a score that moved 17 points with no visible
 * reason is the thing this repo keeps being caught by.
 *
 * @param {{
 *   fit: object|null,
 *   success: {reasons: string[]},
 *   offFocus: {name: string}|null,
 *   payTerm?: number,
 *   payStart?: number|null
 * }} s
 * @returns {string}
 */
export function rankWhy(s) {
  const why = [];
  if (s.offFocus) why.push(`${s.offFocus.name} is outside your focus: ${OFF_FOCUS_PENALTY} points off`);
  if (s.fit && s.fit.resumePct != null) {
    why.push(`resume: better than ${s.fit.resumePct}% of your queue - matches ${(s.fit.matched || []).slice(0, 6).join(', ')}`);
    if ((s.fit.missing || []).length) why.push(`not in your resume: ${s.fit.missing.slice(0, 6).join(', ')}`);
  }
  /* Pay is in the headline only when fit was measured. The unread branch
     ignores it, so naming a pay percentile there would claim a movement
     that did not happen. */
  if (s.fit && s.payTerm != null) {
    if (s.payStart == null) {
      why.push('pay: no published band, treated as the median of priced postings');
    } else {
      why.push(`pay: starts at $${Math.round(s.payStart / 1000)}k, higher than ${s.payTerm}% of priced postings`);
    }
  }
  if (s.fit) why.push(...(s.fit.hits || []).slice(0, 3));
  why.push(...(s.success && s.success.reasons || []));
  return why.join(' | ').slice(0, 800);
}

/**
 * The D1 UPDATE for one scored row. A failed gate clears rank_pct and
 * pay_tier rather than leaving the previous score sitting on a posting he
 * cannot take.
 *
 * @param {{
 *   job: Record<string, any>,
 *   gate: {ok: boolean, reasons: string[], excludedDomain?: string|null},
 *   rank: number|null,
 *   pay_tier: 1|2|3|null,
 *   fit: object|null,
 *   success: {pct: number, reasons: string[]},
 *   jdRead: boolean,
 *   offFocus: {name: string}|null
 * }} s
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function rankWrite(s) {
  /* Named, not a TypeError on `undefined.dedupe_key`. daily.mjs called this
     with the bare scoreOne() result, which carries no job, and every write
     in the twice-daily pipeline threw into a catch that only counted it. */
  const key = s.job && s.job.dedupe_key;
  if (!key) throw new Error('rankWrite: no job.dedupe_key - pass { ...scoreOne(job, jd, payStarts), job }');
  if (!s.gate.ok) {
    return {
      sql: `UPDATE jobs SET status = ?, blocked_reason = ?,
        blocked_detail = ?, excluded_domain = ?, blocked_at = ?,
        rank_pct = NULL, pay_tier = NULL
        WHERE dedupe_key = ?`,
      params: [
        'skipped',
        'off-criteria',
        (s.gate.reasons || []).join('; ').slice(0, 400),
        s.gate.excludedDomain ?? null,
        new Date().toISOString(),
        key
      ]
    };
  }
  return {
    sql: `UPDATE jobs SET rank_pct = ?, fit_pct = ?, resume_pct = ?, success_pct = ?,
      jd_read = ?, rank_why = ?, pay_tier = ?
      WHERE dedupe_key = ?`,
    params: [
      s.rank,
      s.fit ? s.fit.pct : null,
      s.fit && s.fit.resumePct != null ? s.fit.resumePct : null,
      s.success.pct,
      s.jdRead ? 'yes' : 'no',
      rankWhy(s),
      s.pay_tier,
      key
    ]
  };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const limit = Number(args.limit || 40);
  const jobs = (await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json()).jobs || [];
  /* Rank the postings whose description can actually be READ first. Sorting
     by the old match_pct put aggregator rows at the top, and 23 of the first
     25 had no fetchable description at all -- the scorer was running blind
     on the exact rows it was asked to judge. */
  const live = jobs.filter(j => j.status === 'queued')
    .filter(j => !args.readable || boardRef(j.url))
    .sort((a, b) => (b.match_pct || 0) - (a.match_pct || 0))
    .slice(0, limit);

  /* Built once from the rows about to be scored, not inside the loop.
     A missing distribution would degrade every payTerm to 50, which is
     neutral, not a crash -- but it would also make the run look like pay
     was never wired in. */
  const payStarts = publishedStarts(live);

  let read = 0;
  const scored = [];
  for (const j of live) {
    const jd = await fetchJd(j.url);
    if (jd) read++;
    scored.push({ job: j, ...scoreOne(j, jd, payStarts) });
  }
  scored.sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1));

  console.log(`scored ${live.length} queued postings; descriptions read for ${read}\n`);
  console.log('RANK  OLD  FIT  RES  WIN  COMPANY / TITLE');
  for (const s of scored) {
    const fit = s.fit ? String(s.fit.pct).padStart(3) : ' --';
    const rp = s.fit && s.fit.resumePct != null ? String(s.fit.resumePct).padStart(3) : ' --';
    console.log(`${String(s.rank ?? 'GATE').padStart(4)}  ${String(s.job.match_pct ?? '').padStart(3)}  ${fit}  ${rp}  ${String(s.success.pct).padStart(3)}  ${String(s.job.company).slice(0, 20).padEnd(20)} ${String(s.job.title).slice(0, 44)}`);
    if (!s.gate.ok) console.log(`      ruled out: ${s.gate.reasons.join('; ')}`);
    else if (s.success.reasons.length) console.log(`      ${s.success.reasons.join('; ')}`);
  }
  if (args.write) {
    const CF = process.env.CF_D1_TOKEN || '';
    if (!CF) { console.log('\nCF_D1_TOKEN not set - nothing written.'); process.exitCode = 1; }
    else {
      const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
      const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
      const run = async (sql, params) => {
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
          method: 'POST',
          headers: { authorization: `Bearer ${CF}`, 'content-type': 'application/json' },
          body: JSON.stringify(params === undefined ? { sql } : { sql, params })
        });
        const j = await r.json();
        if (!j.success) throw new Error(JSON.stringify(j.errors));
        return j;
      };
      await ensurePayColumns(run);
      let scoredRows = 0, ruledOut = 0;
      for (const s2 of scored) {
        /* A posting that fails the gate leaves the list entirely. It is not a
           low-ranked job, it is one he cannot take -- and leaving it queued is
           how the runner applied to a security role and a San Francisco role.
           The previous score is cleared in the same statement: a later band
           that fails the gate used to leave the old rank_pct sitting. */
        const w = rankWrite(s2);
        await run(w.sql, w.params);
        if (!s2.gate.ok) ruledOut++;
        else scoredRows++;
      }
      console.log(`\nwrote ${scoredRows} ranked rows to D1; ${ruledOut} ruled out as off-criteria`);
    }
  }

  fs.mkdirSync(path.join(ROOT, 'ingest', 'out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'ingest', 'out', 'fit-report.json'),
    JSON.stringify({ at: new Date().toISOString(), jdRead: read, scored: scored.map(s => ({
      dedupe_key: s.job.dedupe_key, company: s.job.company, title: s.job.title,
      old: s.job.match_pct, rank: s.rank, fit: s.fit?.pct ?? null, success: s.success.pct,
      jdRead: s.jdRead, gate: s.gate, hits: s.fit?.hits ?? [], reasons: s.success.reasons
    })) }, null, 2));
  console.log(`\nreport: ingest/out/fit-report.json`);
}
