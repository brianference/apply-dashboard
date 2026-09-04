/**
 * Shared posting shape helpers. Source modules must not touch the database.
 */

/**
 * @typedef {{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null, refreshed_at: string|null }} SourceJob
 */

/**
 * @param {string} haystack
 * @param {string} word
 * @returns {boolean}
 */
function hasWord(haystack, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/**
 * Drop incomplete rows, optionally filter by query, then apply limit.
 *
 * @param {Array<Partial<SourceJob>>} jobs
 * @param {{ limit?: number, query?: string }} [options]
 * @returns {SourceJob[]}
 */
export function filterJobs(jobs, options = {}) {
  const query = options.query ? String(options.query).trim().toLowerCase() : "";
  let out = [];
  for (const job of jobs) {
    if (!job || !job.company || !job.title || !job.url) continue;
    const row = {
      company: String(job.company).trim(),
      title: String(job.title).trim(),
      url: String(job.url).trim(),
      source: canonicalSource(job.source),
      work_type: job.work_type == null || job.work_type === "" ? null : String(job.work_type).trim(),
      /* Normalised HERE as well as in each source, because this is the one
         function every row passes through on its way to the database. A source
         added later that forgets to parse its date cannot put text in a date
         column. */
      posted: isoFromUnknown(job.posted),
      /* Null, not a guessed crawl time. "No refresh date" has to stay
         distinguishable from "refreshed long ago" or the stale lens treats
         unknown as old and hides rows our ingest simply never dated. */
      refreshed_at: isoFromUnknown(job.refreshed_at)
    };
    if (!row.company || !row.title || !row.url) continue;
    if (query) {
      const hay = `${row.title} ${row.company} ${row.work_type || ""}`;
      const words = query.split(/\s+/).filter(Boolean);
      if (!words.every((word) => hasWord(hay, word))) continue;
    }
    out.push(row);
  }
  if (Number.isFinite(options.limit) && options.limit >= 0) {
    out = out.slice(0, options.limit);
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
/**
 * A date embedded in text that is not itself a date.
 *
 * 25 rows carried "Posted 2 Days Ago (startDate 2026-08-20)" in `posted`,
 * because the old pass-through below returned any unparseable string as-is.
 * The real date is right there, so it is recovered rather than discarded.
 */
const EMBEDDED_DATE = /(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

export function isoFromUnknown(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const raw = String(value);
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  /* Recover a date the surrounding words hid. */
  const found = raw.match(EMBEDDED_DATE);
  if (found) {
    const inner = new Date(found[1]);
    if (!Number.isNaN(inner.getTime())) return inner.toISOString();
  }
  /* NULL, not the original text. A date column holding "Posted 30+ Days Ago"
     renders a broken age, sorts as a string, and is invisible to the
     posted-within filter, which is strictly worse than an admitted blank --
     and it also reads as PRESENT, so the backfill skips the row forever. */
  return null;
}

/* The nine source modules, plus workday, which reaches the queue through
   jd-read rather than a module of its own. */
export const CANONICAL_SOURCES = [
  "greenhouse", "lever", "ashby", "remoteok", "himalayas",
  "weworkremotely", "jobspresso", "oracle", "workday"
];

const CANONICAL_BY_LOWER = new Map(CANONICAL_SOURCES.map((id) => [id, id]));

/**
 * Fold a source label onto its module id when the two differ only by case.
 *
 * The queue carried 30 "greenhouse" beside 18 "Greenhouse", 22 "ashby" beside
 * 21 "Ashby", and the same for lever and workday. The capitalised spellings are
 * older rows that stopped updating, so a per-source count showed each board
 * twice, once of them apparently dead.
 *
 * Only a label that collides with a module id is folded. "Working Nomads",
 * "LinkedIn" and "Indeed/aggregator" are not board modules and keep the
 * spelling they were entered with.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalSource(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  return CANONICAL_BY_LOWER.get(text.toLowerCase()) || text;
}

/**
 * Join location-ish fragments into work_type.
 *
 * @param {...(string|null|undefined)} parts
 * @returns {string|null}
 */
export function joinWorkType(...parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const text = String(part || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.length ? out.join(" / ") : null;
}
