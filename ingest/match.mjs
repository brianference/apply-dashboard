/**
 * Deterministic match scoring and lane assignment for a Product Manager
 * targeting remote US senior/principal/staff PM roles (AI / platform / growth).
 *
 * Formula (integer points, then clamp to 0..100):
 *
 * Role (one bucket):
 *   +40  title matches "product manager" or "product owner"
 *   +30  title contains "product" and (manager|lead|director|owner)
 *   +15  title contains "product"
 *   +10  title matches technical/program manager
 *
 * Seniority (one bucket):
 *   +20  principal
 *   +18  staff
 *   +15  senior / sr
 *   +12  lead
 *   +8   director
 *
 * Domain (stackable):
 *   +15  ai / ml / genai / llm / agentic / agent
 *   +10  platform
 *   +10  growth
 *
 * Location (one bucket, from title + work_type):
 *   +15  remote AND US
 *   +8   remote only
 *   +5   US only
 */

const ROLE_PM = /\bproduct manager\b|\bproduct owner\b/i;
const ROLE_PRODUCT_LEAD = /\bproduct\b/i;
const ROLE_LEAD_WORD = /\b(manager|lead|director|owner)\b/i;
const ROLE_TPM = /\btechnical program manager\b|\bprogram manager\b|\btpm\b/i;

const SENIORITY = [
  { points: 20, re: /\bprincipal\b/i },
  { points: 18, re: /\bstaff\b/i },
  { points: 15, re: /\bsenior\b|\bsr\.?\b/i },
  { points: 12, re: /\blead\b/i },
  { points: 8, re: /\bdirector\b/i }
];

const AI = /\b(ai|ml|machine learning|genai|llm|agentic|agents?)\b/i;
const PLATFORM = /\bplatform\b/i;
const GROWTH = /\bgrowth\b/i;
const REMOTE = /\bremote\b/i;
const US = /\b(united states|u\.s\.a\.|u\.s\.|usa|americas)\b|\bus\b/i;
const CONTRACT = /\b(contract|contractor|c2c|1099|part[-\s]?time|hourly|freelance|fractional|consultant)\b/i;

/**
 * @param {{ title?: string, work_type?: string }} job
 */
function haystack(job) {
  return `${job && job.title ? job.title : ""} ${job && job.work_type ? job.work_type : ""}`;
}

/**
 * Reproducible integer score in 0..100. Same inputs always yield the same output.
 *
 * @param {{ title?: string, work_type?: string }} job
 * @returns {number}
 */
export function scoreMatch(job) {
  const title = job && job.title ? job.title : "";
  const hay = haystack(job);
  let score = 0;

  if (ROLE_PM.test(title)) score += 40;
  else if (ROLE_PRODUCT_LEAD.test(title) && ROLE_LEAD_WORD.test(title)) score += 30;
  else if (ROLE_PRODUCT_LEAD.test(title)) score += 15;
  else if (ROLE_TPM.test(title)) score += 10;

  for (const row of SENIORITY) {
    if (row.re.test(title)) {
      score += row.points;
      break;
    }
  }

  if (AI.test(hay)) score += 15;
  if (PLATFORM.test(hay)) score += 10;
  if (GROWTH.test(hay)) score += 10;

  const remote = REMOTE.test(hay);
  const us = US.test(hay);
  if (remote && us) score += 15;
  else if (remote) score += 8;
  else if (us) score += 5;

  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

/**
 * Contract / C2C / part-time / 1099 roles go to ptc2c; everything else is ft.
 *
 * @param {{ title?: string, work_type?: string }} job
 * @returns {"ptc2c"|"ft"}
 */
export function assignLane(job) {
  return CONTRACT.test(haystack(job)) ? "ptc2c" : "ft";
}

/**
 * Dedupe key: lowercase company + "|" + lowercase title.
 *
 * @param {string} company
 * @param {string} title
 * @returns {string}
 */
export function dedupeKey(company, title) {
  return `${String(company || "").toLowerCase()}|${String(title || "").toLowerCase()}`;
}

const DECORATION_WORDS = /\b(remote|eligible|hybrid|onsite|on site|us|usa|united states|full time|contract)\b/g;

/**
 * @param {string} value
 */
function normalizeWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(DECORATION_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Same job, different listing: aggregator boards re-title a posting with a
 * trailing "- CompanyName" (Applied Systems on iCims/BuiltIn) or swap the
 * punctuation joining title and qualifier (an en dash on Ashby vs. a comma on
 * Jobspresso for the same Hopper posting). Neither changes the job.
 *
 * This is deliberately narrower than "titles that look similar" -- Brian's
 * rule (2026-08-25) is that the guard must also never collapse two real,
 * different postings at the same company, the way "Product Manager" and
 * "Product Manager - Partner Experience" are different jobs at Cisco. Only a
 * suffix that is EXACTLY the company's own name is stripped; any other
 * qualifier (a team, a product area) is left alone and the titles stay
 * distinct.
 *
 * @param {string} company
 * @param {string} title
 * @returns {string}
 */
export function normalizedJobKey(company, title) {
  const c = normalizeWords(company);
  let t = normalizeWords(title);
  if (c && t.endsWith(" " + c) && t !== c) t = t.slice(0, -(c.length + 1)).trim();
  return `${c}|${t}`;
}

/**
 * @param {{ company?: string, title?: string }} a
 * @param {{ company?: string, title?: string }} b
 * @returns {boolean}
 */
export function sameJob(a, b) {
  return normalizedJobKey(a && a.company, a && a.title) === normalizedJobKey(b && b.company, b && b.title);
}
