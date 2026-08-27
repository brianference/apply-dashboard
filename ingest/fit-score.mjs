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
 * averaging them into one hides which is failing:
 *
 *   requirements  a GATE, not a score. Salary floor, location, role. A posting
 *                 that fails is not "low ranked", it is off the list.
 *   fit_pct       what the job asks for, against what Brian has actually done.
 *                 Every point cites the requirement line that earned it.
 *   success_pct   whether he could realistically win it: seniority distance,
 *                 hard requirements he does not meet, and whether the
 *                 application can even be submitted.
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
import { locationEligible, roleEligible } from './location-eligible.mjs';
import { corpus, resumeText, resumeMatch, calibrate } from './resume-match.mjs';

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
export function requirementsGate(job, jd) {
  const reasons = [];
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
  const role = roleEligible(job.title);
  if (!role.ok) reasons.push(`role: ${role.why}`);
  const loc = locationEligible(job.work_type, job.title);
  if (!loc.ok) reasons.push(`location: ${loc.why}`);
  /* The bottom of the band is checked before the top. An unpublished start is
     unknown and passes; a published one at or below the floor does not. */
  const bottom = Number(job.salary_min) || 0;
  if (bottom > 0 && bottom < FLOOR_START) {
    reasons.push(`salary: the range starts at $${Math.round(bottom / 1000)}k, below the $${FLOOR_START / 1000}k start floor`);
  }
  const top = Number(job.salary_max) || Number(job.salary_min) || 0;
  /* An unpublished salary is UNKNOWN, not low. Most postings publish nothing
     and dropping them would empty the list. Only a PUBLISHED figure can fail. */
  if (top > 0 && top < SECOND_TIER) reasons.push(`salary: publishes $${Math.round(top / 1000)}k, below the $160k second tier`);
  else if (top > 0 && top < FLOOR) reasons.push(`salary: publishes $${Math.round(top / 1000)}k, under the $180k floor (second tier)`);
  return { ok: reasons.length === 0, reasons };
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

const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/** @param {string} url @returns {Promise<string|null>} */
/** id -> board token, built once from every Greenhouse board we already know. */
let GH_INDEX = null;
async function greenhouseIndex() {
  if (GH_INDEX) return GH_INDEX;
  const idxFile = path.join(CACHE, 'gh-index.json');
  fs.mkdirSync(CACHE, { recursive: true });
  if (fs.existsSync(idxFile)) {
    try { GH_INDEX = JSON.parse(fs.readFileSync(idxFile, 'utf8')); return GH_INDEX; } catch { /* rebuild */ }
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

export async function fetchJd(url) {
  const ref = boardRef(url);
  if (!ref) return null;
  if (ref.ats === 'greenhouse' && !ref.token) {
    const idx = await greenhouseIndex();
    ref.token = idx[ref.id] || null;
    if (!ref.token) return null;          // unknown board: unread, never guessed
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const cacheFile = path.join(CACHE, `${ref.ats}-${ref.token}-${ref.id}`.replace(/[^a-z0-9-]/gi, '_') + '.txt');
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8');
  let text = null;
  try {
    if (ref.ats === 'greenhouse') {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${ref.token}/jobs/${ref.id}?content=true`);
      if (r.ok) text = strip((await r.json()).content);
    } else if (ref.ats === 'ashby') {
      const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${ref.token}`);
      if (r.ok) {
        const j = (await r.json()).jobs.find(x => x.id === ref.id);
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
  } catch { return null; }
  if (text && text.length > 100) { fs.writeFileSync(cacheFile, text, 'utf8'); return text; }
  return null;
}

/**
 * Score one posting end to end.
 * @param {Record<string, any>} job
 * @param {string|null} jd
 */
export function scoreOne(job, jd) {
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
  /* The headline is deliberately NOT an average. A posting that fails the gate
     has no headline at all, and one whose description was unreadable carries
     its success score alone, clearly marked. */
  const rank = !gate.ok ? null
    : fit === null ? Math.round(success.pct * 0.6)
      : Math.round(fit.pct * 0.55 + success.pct * 0.45);
  return { gate, fit, success, rank, jdRead: !!jd };
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

  let read = 0;
  const scored = [];
  for (const j of live) {
    const jd = await fetchJd(j.url);
    if (jd) read++;
    scored.push({ job: j, ...scoreOne(j, jd) });
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
      const q = v => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
      const run = async (sql) => {
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
          method: 'POST',
          headers: { authorization: `Bearer ${CF}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sql })
        });
        const j = await r.json();
        if (!j.success) throw new Error(JSON.stringify(j.errors));
        return j;
      };
      let scoredRows = 0, ruledOut = 0;
      for (const s2 of scored) {
        const k = q(s2.job.dedupe_key);
        if (!s2.gate.ok) {
          /* A posting that fails the gate leaves the list entirely. It is not a
             low-ranked job, it is one he cannot take -- and leaving it queued is
             how the runner applied to a security role and a San Francisco role. */
          await run(`UPDATE jobs SET status='skipped', blocked_reason='off-criteria',
            blocked_detail=${q(s2.gate.reasons.join('; ').slice(0, 400))},
            blocked_at=${q(new Date().toISOString())} WHERE dedupe_key=${k}`);
          ruledOut++;
          continue;
        }
        const why = [];
        if (s2.fit && s2.fit.resumePct != null) {
          why.push(`resume: better than ${s2.fit.resumePct}% of your queue - matches ${s2.fit.matched.slice(0, 6).join(', ')}`);
          if (s2.fit.missing.length) why.push(`not in your resume: ${s2.fit.missing.slice(0, 6).join(', ')}`);
        }
        if (s2.fit) why.push(...s2.fit.hits.slice(0, 3));
        why.push(...s2.success.reasons);
        await run(`UPDATE jobs SET rank_pct=${s2.rank ?? 'NULL'},
          fit_pct=${s2.fit ? s2.fit.pct : 'NULL'},
          resume_pct=${s2.fit && s2.fit.resumePct != null ? s2.fit.resumePct : 'NULL'},
          success_pct=${s2.success.pct},
          jd_read=${q(s2.jdRead ? 'yes' : 'no')},
          rank_why=${q(why.join(' | ').slice(0, 800))}
          WHERE dedupe_key=${k}`);
        scoredRows++;
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
