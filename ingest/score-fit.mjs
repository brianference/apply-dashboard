/**
 * Score every posting against CRITERIA.md, reproducibly.
 *
 * The existing match_pct cannot be trusted. CRITERIA.md records why: it "was
 * produced by the sandbox HuntRank agent and the rubric was never written
 * down", and the sandbox is gone. On top of that only 170 of 378 rows carry a
 * value at all, so most of the queue was being ordered by nothing.
 *
 * This rubric is written down, runs off data already in D1, and gives the same
 * answer every time. Each component is capped so no single signal can carry a
 * posting, and every score ships with the reasons that produced it.
 *
 *   node ingest/score-fit.mjs            # report only
 *   node ingest/score-fit.mjs --write    # also emit SQL
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const FLOOR = 180000;
const SECOND = 160000;

/* ---- the rubric, straight out of CRITERIA.md ---- */

/** Tier 1 is a real AI PM role: AI in the role itself, not the company blurb. */
const AI_ROLE = /\b(ai|ml|machine learning|llm|genai|generative|agent(ic)?|model|inference|rag|copilot)\b/i;
/** Seniority he is targeting, Senior being the centre of mass. */
const PRINCIPAL = /\b(principal|staff|lead|director|head of|group product)\b/i;
const SENIOR = /\b(senior|sr\.?)\b/i;
/** Titles that are not product management at all. */
const NOT_PM = /\b(program manager|project manager|product marketing|product design|engineering manager|data scientist|solutions? (architect|engineer)|sales|recruiter)\b/i;
/** Company shapes he targets. */
const SHAPE = /\b(saas|developer|devtool|infrastructure|platform|api|cloud|security|identity|fintech|payments|data|observability)\b/i;
/** Companies he returns to, from CRITERIA.md. */
const FAVOURITES = /^(webflow|gitlab|engine|anthropic|campminder|figma|coinbase|cribl|new relic|instacart)$/i;

/**
 * @param {object} j a jobs row
 * @returns {{score:number, why:string[]}}
 */
export function scoreJob(j) {
  const title = String(j.title || '');
  const company = String(j.company || '');
  const where = String(j.work_type || '');
  const why = [];
  let score = 40; // a PM role that clears the basic filter starts here

  if (NOT_PM.test(title)) return { score: 0, why: ['not a product-management title'] };

  if (AI_ROLE.test(title)) { score += 18; why.push('tier 1: AI in the role itself (+18)'); }
  else if (AI_ROLE.test(company)) { score += 4; why.push('AI company, generic role (+4)'); }

  if (PRINCIPAL.test(title)) { score += 12; why.push('principal/staff/lead level (+12)'); }
  else if (SENIOR.test(title)) { score += 10; why.push('senior level (+10)'); }
  else { score -= 6; why.push('no seniority marker in the title (-6)'); }

  /* Salary, the bar CRITERIA.md says could never be enforced before. */
  const top = Number(j.salary_max ?? j.salary_min ?? 0);
  if (top >= 250000) { score += 14; why.push(`band tops out at ${top} (+14)`); }
  else if (top >= FLOOR) { score += 10; why.push(`band clears the ${FLOOR} floor (+10)`); }
  else if (top >= SECOND) { score += 2; why.push(`band is second-priority ${SECOND}-${FLOOR} (+2)`); }
  else if (top > 0) { score -= 20; why.push(`band tops out at ${top}, under the floor (-20)`); }
  else { why.push('no published band (0)'); }

  if (/remote/i.test(where)) { score += 8; why.push('remote (+8)'); }
  else if (/scottsdale|phoenix|arizona|\bAZ\b/i.test(where)) { score += 6; why.push('within his metro (+6)'); }
  else if (where) { score -= 10; why.push('on-site outside his metro (-10)'); }

  if (SHAPE.test(title) || SHAPE.test(company)) { score += 6; why.push('B2B SaaS / devtools / infra shape (+6)'); }
  if (FAVOURITES.test(company.trim())) { score += 8; why.push('a company he returns to (+8)'); }

  /* Freshness. CRITERIA.md asks for the last 5 days; decay rather than cliff. */
  if (j.posted) {
    const age = (Date.now() - new Date(j.posted).getTime()) / 86400000;
    if (age <= 5) { score += 6; why.push(`posted ${Math.round(age)}d ago (+6)`); }
    else if (age <= 14) { score += 2; why.push(`posted ${Math.round(age)}d ago (+2)`); }
    else if (age > 45) { score -= 8; why.push(`posted ${Math.round(age)}d ago, stale (-8)`); }
  }

  if (j.link_status && j.link_status !== 'live') { score -= 25; why.push(`link is ${j.link_status} (-25)`); }

  /* Normalise against the best a posting can actually score rather than
     clamping at 99. Three roles came out tied at 99 because their raw scores
     were 100, 104 and 100 and the clamp hid that Reddit was the strongest of
     them. Scaling keeps the ordering and stops the top of the list collapsing
     into a tie.

     BEST is the sum of every positive component: 40 base + 18 AI role + 12
     principal + 14 top band + 8 remote + 6 shape + 8 favourite + 6 fresh. */
  const BEST = 112;
  score = Math.max(0, Math.min(99, Math.round((score / BEST) * 99)));
  return { score, why };
}

/* ---- run ---- */
if (process.argv[1] && process.argv[1].includes('score-fit')) {
  const jobs = await fetch(API, { headers: { 'cache-control': 'no-cache' } }).then(r => r.json()).then(d => d.jobs);
  const scored = jobs.map(j => ({ j, ...scoreJob(j) }));
  const queued = scored.filter(s => s.j.status === 'queued').sort((a, b) => b.score - a.score);

  console.log(`scored ${scored.length} rows, ${queued.length} of them queued\n`);
  console.log('TOP 15 QUEUED BY FIT');
  for (const s of queued.slice(0, 15)) {
    console.log(`  ${String(s.score).padStart(2)}  ${s.j.company} | ${s.j.title.slice(0, 52)}`);
    console.log(`      ${s.why.join(', ')}`);
  }
  console.log('\nBOTTOM 5 QUEUED');
  for (const s of queued.slice(-5)) {
    console.log(`  ${String(s.score).padStart(2)}  ${s.j.company} | ${s.j.title.slice(0, 52)}  <- ${s.why.join(', ')}`);
  }

  const old = scored.filter(s => s.j.match_pct != null);
  const drift = old.filter(s => Math.abs(s.j.match_pct - s.score) >= 20);
  console.log(`\n${old.length} rows carried an old match_pct; ${drift.length} disagree with this rubric by 20 points or more.`);

  if (process.argv.includes('--write')) {
    const esc = (s) => String(s).replace(/'/g, "''");
    const sql = scored.map(s => `UPDATE jobs SET match_pct=${s.score} WHERE dedupe_key='${esc(s.j.dedupe_key)}';`);
    const out = path.join(ROOT, 'ingest', 'out', 'score-fit.sql');
    fs.writeFileSync(out, sql.join('\n') + '\n');
    console.log(`\n${sql.length} statements -> ${out}`);
  }
}
