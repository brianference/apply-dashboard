/**
 * Compare a job description against Brian's actual resume.
 *
 * `fit-score.mjs` scores a posting against a CONCEPTS table that was written by
 * hand from his narrative. That encodes judgement, and it is useful, but it is
 * my summary of him -- not his resume. Asked directly whether the ranking
 * compared the job description to his resume, the honest answer was no.
 * This module is the missing half.
 *
 * The hard part is deciding WHICH words in a job description matter. Counting
 * every shared word rewards "product", "team" and "customer", which appear in
 * every posting and in every resume, and would score everything alike -- the
 * same trap that pinned the first fit score at 100.
 *
 * So distinctiveness is measured, not assumed: inverse document frequency over
 * every job description already cached in ingest/out/jd-cache. A term used by
 * one posting in a hundred is what that posting actually wants; a term used by
 * eighty is boilerplate. Only distinctive terms are looked for in the resume.
 * Nothing here is a guess about Brian -- a term either appears in his resume
 * text or it does not.
 *
 *   node ingest/resume-match.mjs --url <postingUrl>
 *   node ingest/resume-match.mjs --self-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { isCli, parseArgs } from './cli.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const CACHE = path.join(ROOT, 'ingest', 'out', 'jd-cache');
const RESUME = path.join(ROOT, 'apply', 'resume-text.local.txt');

/* Words that carry no signal about whether he can do a job. Deliberately
   short: the IDF pass removes ordinary language on its own, and a long
   hand-written stoplist is another place to smuggle in judgement. */
const STOP = new Set(`the and for with you our are will that this have has your from they their
  who what when where how all any can may not but out its into more most other some such than then
  these those very what which while about above after again against because been before being below
  between both cannot could did does doing down during each few further here itself just once only
  over same should through too under until upon were whom why would able across among around
  team teams work working works role roles job jobs position company companies year years
  including include includes new using use used need needs want wants join looking love great
  strong excellent ability experience experiences skill skills required requirements qualifications
  preferred plus bonus nice must should responsibilities responsibility opportunity opportunities
  candidate candidates applicant people person world class best good better help helps helping
  build builds building make makes making drive drives driving own owns owning lead leads leading
  ensure ensures partner partners partnering across within based well also one two three four five`
  .split(/\s+/).filter(Boolean));

/** @param {string} text @returns {string[]} */
export function terms(text) {
  const words = String(text || '').toLowerCase()
    .replace(/[^a-z0-9+#./ -]/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^[-./]+|[-./]+$/g, ''))
    .filter(w => w.length >= 3 && w.length <= 28 && !STOP.has(w) && !/^\d+$/.test(w));
  const out = new Set(words);
  /* Two-word phrases carry most of the real requirements: "machine learning",
     "design partner", "go to market". Single words alone lose them. */
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (STOP.has(a) || STOP.has(b)) continue;
    out.add(a + ' ' + b);
  }
  return [...out];
}

/**
 * Document frequency across every cached job description.
 * @returns {{df: Map<string, number>, docs: number}}
 */
export function corpus() {
  const df = new Map();
  let docs = 0;
  let files = [];
  try { files = fs.readdirSync(CACHE).filter(f => f.endsWith('.txt')); } catch { return { df, docs: 0 }; }
  for (const f of files) {
    let t = '';
    try { t = fs.readFileSync(path.join(CACHE, f), 'utf8'); } catch { continue; }
    if (t.length < 300) continue;
    docs++;
    for (const term of terms(t)) df.set(term, (df.get(term) || 0) + 1);
  }
  return { df, docs };
}

/** @returns {string|null} */
export function resumeText() {
  try { return fs.readFileSync(RESUME, 'utf8'); } catch { return null; }
}

/**
 * Which of a posting's DISTINCTIVE requirements appear in the resume.
 *
 * Returns null rather than a number when it cannot be measured -- no resume,
 * no description, or a corpus too small for document frequency to mean
 * anything. A fabricated percentage is worse than an absent one.
 *
 * @param {string} jd
 * @param {string|null} resume
 * @param {{df: Map<string, number>, docs: number}} c
 * @param {number} [top] how many distinctive terms to test
 */
export function resumeMatch(jd, resume, c, top = 40) {
  if (!jd || jd.length < 300) return null;
  if (!resume || resume.length < 300) return null;
  if (!c || c.docs < 20) return null;          // IDF is meaningless on a handful

  /* Match on a loose stem, not an exact string. A resume says "engineering"
     where a posting says "engineers", and "forecast" where it says
     "forecasting" -- scoring those as misses measures spelling, not fit. */
  const stem = (w) => w.replace(/(ing|ers|er|ies|ed|es|s)$/g, '');
  const res = String(resume).toLowerCase();
  const resStems = new Set(res.replace(/[^a-z0-9+#. -]/g, ' ').split(/\s+/).map(stem).filter(Boolean));
  const inResume = (t) => {
    if (res.includes(t)) return true;
    /* A phrase counts when every one of its words is in the resume, even if
       the exact pairing is not -- "design partner" is evidenced by a resume
       that discusses design and partners, and demanding the literal bigram
       throws away most real matches. */
    return t.split(' ').every(w => resStems.has(stem(w)));
  };
  const seen = terms(jd);
  /* Distinctive = used by this posting and by few others. A term the corpus has
     never seen is usually a typo or a product name split oddly, so require it
     to appear at least twice before trusting it. */
  const scored = seen
    .map(t => ({ t, df: c.df.get(t) || 0 }))
    /* 10% not 25%: a term a quarter of all postings use is still boilerplate,
       and letting it through is what left an out-of-field posting scoring
       within 15 points of an in-field one. */
    .filter(x => x.df >= 2 && x.df <= Math.max(3, Math.floor(c.docs * 0.10)))
    .map(x => ({ ...x, idf: Math.log(c.docs / x.df) }))
    .sort((a, b) => b.idf - a.idf)
    .slice(0, top);

  if (scored.length < 8) return null;          // too little to judge

  let have = 0, total = 0;
  const matched = [], missing = [];
  for (const x of scored) {
    total += x.idf;
    if (inResume(x.t)) { have += x.idf; matched.push(x.t); }
    else missing.push(x.t);
  }
  return {
    pct: Math.round((have / total) * 100),
    matched: matched.slice(0, 12),
    missing: missing.slice(0, 12),
    tested: scored.length
  };
}

/* Raw resume overlap runs 0-30 on real postings: a two-page resume cannot
   contain most of a job description's distinctive terms, however well suited he
   is. Reporting that raw number as a percentage, or averaging it with a score
   that runs 45-94, says a good job is a bad one. So it is calibrated: a raw
   score becomes its PERCENTILE against every cached description, which is the
   honest statement -- "this posting matches your resume better than N% of the
   postings in your queue". Calibrating against the corpus rather than the batch
   keeps the answer stable as the queue changes.
   @returns {number[]} sorted raw scores, one per cached description */
let CALIB = null;
export function calibration() {
  if (CALIB) return CALIB;
  const file = path.join(CACHE, 'resume-calibration.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j.raw) && j.raw.length >= 20) { CALIB = j.raw; return CALIB; }
  } catch { /* build it */ }
  const c = corpus();
  const resume = resumeText();
  const raw = [];
  let files = [];
  try { files = fs.readdirSync(CACHE).filter(f => f.endsWith('.txt')); } catch { return (CALIB = []); }
  for (const f of files) {
    let t = '';
    try { t = fs.readFileSync(path.join(CACHE, f), 'utf8'); } catch { continue; }
    const m = resumeMatch(t, resume, c);
    if (m) raw.push(m.pct);
  }
  raw.sort((a, b) => a - b);
  try { fs.writeFileSync(file, JSON.stringify({ builtAt: new Date().toISOString(), raw })); } catch { /* cache is optional */ }
  CALIB = raw;
  return raw;
}

/**
 * Turn a raw overlap into a percentile against the corpus.
 * @param {number} raw
 * @returns {number|null}
 */
export function calibrate(raw) {
  const c = calibration();
  if (!c.length || c.length < 20) return null;
  let below = 0;
  for (const v of c) { if (v < raw) below++; else break; }
  return Math.round((below / c.length) * 100);
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const c = corpus();
  const resume = resumeText();
  console.log(`corpus: ${c.docs} cached descriptions, ${c.df.size} distinct terms`);
  console.log(`resume: ${resume ? resume.length + ' chars' : 'NOT FOUND at ' + RESUME}`);

  if (args['self-check']) {
    /* Without the resume text or a corpus there is nothing to measure. Skipping
       loudly beats failing (the rules are fine, the environment is bare) and
       beats passing (a green tick would claim the resume match was verified
       when it never ran). */
    if (!resume || c.docs < 20) {
      console.log(`
SKIPPED: resume match cannot be measured here`
        + ` (resume ${resume ? 'present' : 'missing'}, corpus ${c.docs} descriptions).`
        + ` This is an environment gap, not a passing test.`);
      process.exit(0);
    }
    /* The check that must FAIL: a description from a field he has never worked
       in has to score below one squarely in his record. If both come out the
       same, the measure is not measuring anything. */
    const near = `Requirements: 5+ years product management for an enterprise SaaS platform.
      You will own the roadmap for LLM and generative AI features, run experimentation,
      partner with design, and build reporting and dashboards for finance and accounting
      teams. Familiarity with stock compensation, equity administration and ASC 718
      reporting is a plus. You will work cross-functional with engineering.`.repeat(4);
    const far = `Requirements: 8+ years managing hardware and firmware programs for
      autonomous vehicles. Deep knowledge of lidar calibration, sensor fusion, embedded
      real time operating systems, CAN bus, thermal management and automotive safety
      certification. You will own supplier qualification and factory bring up for
      semiconductor components.`.repeat(4);
    const a = resumeMatch(near, resume, c);
    const b = resumeMatch(far, resume, c);
    console.log(`\nin his field : ${a ? a.pct + '%' : 'null'}  ${a ? 'matched: ' + a.matched.slice(0, 6).join(', ') : ''}`);
    console.log(`out of field : ${b ? b.pct + '%' : 'null'}  ${b ? 'missing: ' + b.missing.slice(0, 6).join(', ') : ''}`);
    console.log(`
calibration corpus: ${calibration().length} scored descriptions`);
    console.log(`in-field  calibrated: ${a ? calibrate(a.pct) : 'null'}th percentile`);
    console.log(`out-field calibrated: ${b ? calibrate(b.pct) : 'null'}th percentile`);
    const ok = a && b && (a.pct - b.pct) >= 20;
    console.log(ok
      ? `\nok  the resume match separates them by ${a.pct - b.pct} points`
      : `\nFAIL it cannot tell them apart, so it is not measuring the resume`);
    console.log(resumeMatch('too short', resume, c) === null ? 'ok  a short description returns null, not a guess' : 'FAIL short description scored');
    console.log(resumeMatch(near, null, c) === null ? 'ok  no resume returns null, not a guess' : 'FAIL scored without a resume');
    process.exitCode = ok ? 0 : 1;
  }
}
