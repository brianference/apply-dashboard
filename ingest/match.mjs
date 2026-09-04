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

/**
 * Normalise a company or title for duplicate detection: punctuation dropped,
 * and the decorations that vary between boards removed.
 *
 * Originally written in apply/batch.mjs as the last-second check before
 * submitting -- Brian's rule, 2026-08-25: aggressively prevent duplicates. An
 * exact dedupe_key or URL match is not enough. The same job is listed under
 * different keys when a title picks up or loses a suffix ("(Remote
 * Eligible)", "- US", "II", a comma where another board used a hyphen), or
 * when a company name is written two ways ("Kin" / "Kin Insurance").
 *
 * Shared here so the SAME normalisation runs at ingest time
 * (ingest/sync-to-d1.mjs), not only in the last-second check immediately
 * before a submission -- otherwise two still-queued rows for the same
 * posting can sit side by side and both look submittable.
 *
 * @param {string} v
 * @returns {string}
 */
export function normalizeForDedupe(v) {
  return String(v || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(remote|eligible|hybrid|onsite|on site|us|usa|united states|full time|contract)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

/**
 * Is `a` the same posting as `b`, judged on normalised company and title
 * rather than an exact key or URL match?
 *
 * @param {{company?: string, title?: string}} a
 * @param {{company?: string, title?: string}} b
 * @returns {boolean}
 */
/**
 * A title with its own employer appended, which several boards do.
 *
 * Twilio's "Staff Product Manager - Enterprise AI" arrived from a second board
 * as "Staff Product Manager - Enterprise AI - Twilio", and Mitratech's did the
 * same. Both sat in the queue twice, and one Twilio pair reached SUBMITTED
 * twice, which is the duplicate application this whole rule exists to prevent.
 *
 * Only a trailing occurrence is removed, and only when what is left still names
 * a job. "Product Manager, Twilio Voice" keeps its Twilio because the word is
 * not at the end.
 *
 * @param {string} title already normalised
 * @param {string} company already normalised
 * @returns {string}
 */
export function withoutTrailingCompany(title, company) {
  const t = String(title || "");
  const c = String(company || "");
  if (!t || !c || !t.endsWith(c)) return t;
  const cut = t.slice(0, t.length - c.length).trim();
  /* Never strip down to nothing, or two unrelated postings at one employer
     both normalise to the empty string and every job matches every other. */
  return cut.length >= 4 ? cut : t;
}

/**
 * Is `a` the same posting as `b`, judged on normalised company and title
 * rather than an exact key or URL match?
 *
 * The title comparison also tries each side with the employer's name stripped
 * off the end, because that suffix is added by the BOARD rather than by the
 * employer and says nothing about which job it is.
 *
 * @param {{company?: string, title?: string}} a
 * @param {{company?: string, title?: string}} b
 * @returns {boolean}
 */
export function sameJob(a, b) {
  const ca = normalizeForDedupe(a && a.company);
  const cb = normalizeForDedupe(b && b.company);
  if (ca !== cb) return false;
  const ta = normalizeForDedupe(a && a.title);
  const tb = normalizeForDedupe(b && b.title);
  if (ta === tb) return true;
  return withoutTrailingCompany(ta, ca) === withoutTrailingCompany(tb, cb);
}
