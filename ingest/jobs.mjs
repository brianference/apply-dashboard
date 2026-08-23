/**
 * Shared posting shape helpers. Source modules must not touch the database.
 */

/**
 * @typedef {{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null }} SourceJob
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
      source: String(job.source || "").trim(),
      work_type: job.work_type == null || job.work_type === "" ? null : String(job.work_type).trim(),
      posted: job.posted == null || job.posted === "" ? null : String(job.posted)
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
export function isoFromUnknown(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
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
