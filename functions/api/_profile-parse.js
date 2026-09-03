/**
 * Resume parse, section merge, public view and Person JSON-LD.
 *
 * Lives under functions/api/ (underscore so it is not a route) because the
 * Pages Function has to import it, and wrangler only bundles what functions/
 * can reach -- ingest/ is not copied into .deploy. ingest/profile-parse.mjs
 * re-exports this file so node tests import the path the rest of ingest uses.
 *
 * The grammar is THIS resume, measured from the D1 document, not a generic
 * resume shape. A first parser written against "what resumes usually look like"
 * looks for `YYYY - YYYY` and bullet achievements; this document has neither,
 * and that parser would store empty roles.
 */

/** Three-letter months as they appear on the date line. */
const MONTH = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
/**
 * "Mon YYYY to Present", "Mon YYYY to Mon YYYY", and the same two without a
 * month: "2016 to Present".
 *
 * Deliberately NOT `YYYY - YYYY`: no year-bearing line in the source document
 * matches that shape, so a naive range regex finds no dates at all.
 *
 * The month-less form was missed on the first pass and cost a whole role --
 * "Owner, Web Design Company | Web Site AZ LLC" / "2016 to Present" simply did
 * not exist as far as the parser was concerned, and nothing failed, because a
 * role that is never detected leaves no trace to assert against.
 */
const YEAR_OR_MONTH_YEAR = "(?:(?:" + MONTH + ") )?\\d{4}";
export const DATE_LINE = new RegExp(
  "^" + YEAR_OR_MONTH_YEAR + " to (?:Present|" + YEAR_OR_MONTH_YEAR + ")$"
);
const DATE_PARTS = new RegExp(
  "^(?:(" + MONTH + ") )?(\\d{4}) to (Present|(?:(" + MONTH + ") )?(\\d{4}))$"
);

/** A bullet prefix. The source document has zero of these. */
const BULLET = /^[\u2022\u2013\u2014*+\-]\s+/;

/**
 * Section headings: upper-case and alone on a line, same test the public
 * portfolio already uses to slice SUMMARY / SKILLS. A looser test that treated
 * any short line as a heading would split WORK EXPERIENCE at every company.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isHeading(line) {
  return /^[A-Z][A-Z ]{3,}$/.test(String(line || "").trim());
}

const KNOWN = {
  SUMMARY: "summary",
  "WORK EXPERIENCE": "experience",
  "SELECTED PROJECTS": "projects",
  SKILLS: "skills",
  EDUCATION: "education",
  CERTIFICATIONS: "certifications"
};

const VIS_KEYS = [
  "header", "about", "experience", "projects", "skills", "education", "certifications"
];

/** Missing end date is null -- never the string "Present" and never today. */
export const CURRENT_END = null;

/**
 * @returns {{heading: string|null, lines: string[]}[]}
 */
function splitSections(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    const trimmed = line.trim();
    if (isHeading(trimmed)) {
      blocks.push(current);
      current = { heading: trimmed, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  return blocks;
}

/**
 * Blank lines separate prose paragraphs. A line that starts with a bullet is
 * also a paragraph, so a resume that DOES use bullets still parses -- but a
 * splitter that ONLY looks for bullets returns nothing here, because this
 * document has none.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
export function linesToParagraphs(lines) {
  const paragraphs = [];
  let buf = [];
  const flush = () => {
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    buf = [];
  };
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (BULLET.test(trimmed)) {
      flush();
      paragraphs.push(trimmed.replace(BULLET, "").trim());
      continue;
    }
    buf.push(trimmed);
  }
  flush();
  return paragraphs;
}

/**
 * @param {string} dateLine
 * @returns {{start: string, end: string|null, current: boolean}|null}
 */
export function parseDateLine(dateLine) {
  const trimmed = String(dateLine || "").trim();
  const match = trimmed.match(DATE_PARTS);
  if (!match) return null;
  /* The month is optional: "2016 to Present" is a real line in the source
     document. Joining an absent month produced the string "undefined 2016",
     which is worse than a missing month because it looks like data. */
  const join = (month, year) => (month ? month + " " + year : year);
  const start = join(match[1], match[2]);
  const current = match[3] === "Present";
  /* CURRENT_END, not "Present" and not new Date(), so a current role cannot
     grow a fake last day the moment it is parsed. */
  const end = current ? CURRENT_END : join(match[4], match[5]);
  return { start, end, current };
}

/**
 * One WORK EXPERIENCE section. A role is "Title | Company" + a date line
 * + prose paragraphs. An unparseable stretch keeps its raw lines so nothing
 * is silently dropped.
 *
 * @param {string[]} rawLines
 * @returns {Array<object>}
 */
export function parseExperience(rawLines) {
  const lines = rawLines.map((line) => String(line));
  const trimmed = lines.map((line) => line.trim());
  const starts = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (!DATE_LINE.test(trimmed[i])) continue;
    /* The title line is the nearest line above the date that carries a pipe.
       There is no separate company line to look for: the company is the right
       of the pipe. An earlier version kept looking upward for one, claimed the
       preceding PARAGRAPH as the company, and then used that index as the end
       of the previous role -- silently cutting eight long lines of achievement
       text out of the parse. Nothing failed, because text that is never
       assigned leaves nothing to assert against. */
    let titleIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (!trimmed[j]) continue;
      if (DATE_LINE.test(trimmed[j])) break;
      if (trimmed[j].includes(" | ")) { titleIdx = j; }
      break;
    }
    if (titleIdx >= 0) starts.push({ dateIdx: i, titleIdx, companyIdx: -1 });
  }

  if (!starts.length) {
    const kept = trimmed.filter(Boolean);
    if (!kept.length) return [];
    return [{
      company: null, title: null, location: null,
      start: null, end: CURRENT_END, current: false,
      paragraphs: [], raw: kept, source: "resume"
    }];
  }

  const items = [];
  const consumed = new Set();
  for (let s = 0; s < starts.length; s++) {
    const { dateIdx, titleIdx, companyIdx } = starts[s];
    const next = starts[s + 1];
    /* The next role begins at its title line. There is no company line above
       it to stop at, and stopping early is what dropped the paragraphs. */
    const nextHead = next ? next.titleIdx : lines.length;
    const dates = parseDateLine(trimmed[dateIdx]);
    const titleLine = trimmed[titleIdx];
    const pipe = titleLine.indexOf(" | ");
    /* "Title | Company", not "Title | Location".
       The spec that produced this file said location, and the fixture encoded
       that, so every test passed while the real document came out with the
       COMPANY in the location field and an achievement paragraph as the
       company -- the line above a role is prose, not a company name. This
       resume carries no location anywhere, so location is null rather than
       invented, and a caller that wants one has to ask the person. */
    const title = titleLine.slice(0, pipe).trim();
    const company = titleLine.slice(pipe + 3).trim() || null;
    const location = null;
    const body = lines.slice(dateIdx + 1, nextHead);
    const item = {
      company,
      title,
      location,
      start: dates ? dates.start : null,
      end: dates ? dates.end : CURRENT_END,
      current: !!(dates && dates.current),
      paragraphs: linesToParagraphs(body),
      source: "resume"
    };
    if (!company || !title || !dates) {
      item.raw = trimmed.slice(
        companyIdx >= 0 ? companyIdx : titleIdx,
        nextHead
      ).filter(Boolean);
    }
    items.push(item);
    const from = companyIdx >= 0 ? companyIdx : titleIdx;
    for (let k = from; k < nextHead; k++) consumed.add(k);
  }

  /* Lines the role pattern did not claim. Attached to the first role as
     `raw` rather than counted as another role -- a leftover intro line
     must not inflate the role count the tests assert. */
  const leftover = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (!consumed.has(i) && trimmed[i]) leftover.push(trimmed[i]);
  }
  if (leftover.length && items[0]) {
    items[0].raw = (items[0].raw || []).concat(leftover);
  }
  return items;
}

/**
 * @param {string[]} lines
 * @returns {Array<{name: string, paragraphs: string[], url: null, source: string}>}
 */
function parseProjects(lines) {
  const blocks = [];
  let buf = [];
  const flush = () => {
    const nonempty = buf.map((l) => l.trim()).filter(Boolean);
    buf = [];
    if (!nonempty.length) return;
    blocks.push({
      name: nonempty[0],
      paragraphs: nonempty.slice(1),
      url: null,
      source: "resume"
    });
  };
  for (const line of lines) {
    if (!String(line).trim()) flush();
    else buf.push(line);
  }
  flush();
  return blocks;
}

/**
 * @param {string[]} lines
 * @returns {Array<{label: string|null, text: string, source: string}>}
 */
function parseSkills(lines) {
  const items = [];
  for (const line of lines) {
    const trimmed = String(line).trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(": ");
    if (colon > 0 && colon < 46) {
      items.push({
        label: trimmed.slice(0, colon),
        text: trimmed.slice(colon + 2),
        source: "resume"
      });
    } else {
      items.push({ label: null, text: trimmed, source: "resume" });
    }
  }
  return items;
}

/**
 * @param {string[]} lines
 * @returns {Array<{line: string, parts: string[], source: string}>}
 */
function parseLined(lines) {
  const items = [];
  for (const line of lines) {
    const trimmed = String(line).trim();
    if (!trimmed) continue;
    items.push({
      line: trimmed,
      parts: trimmed.includes(" | ")
        ? trimmed.split(" | ").map((p) => p.trim()).filter(Boolean)
        : [trimmed],
      source: "resume"
    });
  }
  return items;
}

/**
 * Join a section into summary prose. Blank lines stay as paragraph breaks.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function joinSummary(lines) {
  return linesToParagraphs(lines).join("\n\n");
}

/**
 * Lines kept as they were, minus one leading and trailing blank run, so an
 * unknown heading is not quietly trimmed into nothing.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function intactLines(lines) {
  const copy = lines.map((l) => String(l));
  while (copy.length && !copy[0].trim()) copy.shift();
  while (copy.length && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

/**
 * Parse a resume. Never invents a field: a missing end date is null, an
 * unparseable role keeps `raw`, an unknown heading becomes `extra`.
 *
 * Every item is `source: "resume"` until a person edits it. The parse is a
 * suggestion; writing it onto the row is a separate, explicit save.
 *
 * @param {string} text
 * @returns {{
 *   name: string|null,
 *   summary: string,
 *   experience: Array<object>,
 *   projects: Array<object>,
 *   skills: Array<object>,
 *   education: Array<object>,
 *   certifications: Array<object>,
 *   extra: Array<{heading: string, lines: string[]}>
 * }}
 */
export function parseResume(text) {
  const out = {
    name: null,
    summary: "",
    experience: [],
    projects: [],
    skills: [],
    education: [],
    certifications: [],
    extra: []
  };
  const blocks = splitSections(text);
  for (const block of blocks) {
    if (!block.heading) continue;
    const kind = KNOWN[block.heading];
    if (kind === "summary") out.summary = joinSummary(block.lines);
    else if (kind === "experience") out.experience = parseExperience(block.lines);
    else if (kind === "projects") out.projects = parseProjects(block.lines);
    else if (kind === "skills") out.skills = parseSkills(block.lines);
    else if (kind === "education") out.education = parseLined(block.lines);
    else if (kind === "certifications") out.certifications = parseLined(block.lines);
    else if (!out.name) out.name = block.heading;
    else out.extra.push({ heading: block.heading, lines: intactLines(block.lines) });
  }
  return out;
}

/**
 * @returns {object}
 */
export function emptySections() {
  const visibility = {};
  for (const key of VIS_KEYS) visibility[key] = true;
  return {
    visibility,
    about: null,
    experience: [],
    projects: [],
    skills: [],
    education: [],
    certifications: [],
    extra: []
  };
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function strOrNull(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  return text ? text : null;
}

/**
 * "Present" is a display word, not a stored end date. A client that sends it
 * is normalised back to null so the invented value cannot land in D1.
 *
 * @param {unknown} end
 * @param {boolean} current
 * @returns {string|null}
 */
function normalizeEnd(end, current) {
  if (current) return CURRENT_END;
  if (end == null || end === "") return CURRENT_END;
  const text = String(end).trim();
  if (!text || /^present$/i.test(text)) return CURRENT_END;
  return text;
}

/**
 * @param {object} item
 * @param {number} index
 * @returns {object}
 */
function normalizeExperienceItem(item, index) {
  const current = !!(item && item.current);
  const paragraphs = Array.isArray(item && item.paragraphs)
    ? item.paragraphs.map((p) => String(p)).filter((p) => p.trim())
    : [];
  const out = {
    id: strOrNull(item && item.id) || "experience-" + index,
    company: strOrNull(item && item.company),
    title: strOrNull(item && item.title),
    location: strOrNull(item && item.location),
    start: strOrNull(item && item.start),
    end: normalizeEnd(item && item.end, current),
    current,
    paragraphs,
    source: item && item.source === "edited" ? "edited" : "resume"
  };
  if (item && Array.isArray(item.raw) && item.raw.length) {
    out.raw = item.raw.map((l) => String(l));
  }
  return out;
}

/**
 * @param {unknown} input
 * @returns {object}
 */
export function normalizeSections(input) {
  const empty = emptySections();
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return empty; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;

  const visIn = value.visibility && typeof value.visibility === "object"
    ? value.visibility
    : {};
  for (const key of VIS_KEYS) {
    if (key in visIn) empty.visibility[key] = visIn[key] !== false;
  }

  if (value.about && typeof value.about === "object") {
    empty.about = {
      text: value.about.text == null ? "" : String(value.about.text),
      source: value.about.source === "edited" ? "edited" : "resume"
    };
  }

  empty.experience = Array.isArray(value.experience)
    ? value.experience.map(normalizeExperienceItem)
    : [];

  empty.projects = Array.isArray(value.projects)
    ? value.projects.map((item, index) => ({
      id: strOrNull(item && item.id) || "project-" + index,
      name: strOrNull(item && item.name) || "",
      paragraphs: Array.isArray(item && item.paragraphs)
        ? item.paragraphs.map((p) => String(p)).filter((p) => p.trim())
        : [],
      url: strOrNull(item && item.url),
      source: item && item.source === "edited" ? "edited" : "resume"
    }))
    : [];

  empty.skills = Array.isArray(value.skills)
    ? value.skills.map((item, index) => ({
      id: strOrNull(item && item.id) || "skill-" + index,
      label: strOrNull(item && item.label),
      text: item && item.text == null ? "" : String(item.text || ""),
      source: item && item.source === "edited" ? "edited" : "resume"
    }))
    : [];

  empty.education = Array.isArray(value.education)
    ? value.education.map((item, index) => ({
      id: strOrNull(item && item.id) || "education-" + index,
      line: strOrNull(item && item.line) || "",
      parts: Array.isArray(item && item.parts)
        ? item.parts.map((p) => String(p))
        : (item && item.line ? [String(item.line)] : []),
      source: item && item.source === "edited" ? "edited" : "resume"
    }))
    : [];

  empty.certifications = Array.isArray(value.certifications)
    ? value.certifications.map((item, index) => ({
      id: strOrNull(item && item.id) || "cert-" + index,
      line: strOrNull(item && item.line) || "",
      parts: Array.isArray(item && item.parts)
        ? item.parts.map((p) => String(p))
        : (item && item.line ? [String(item.line)] : []),
      source: item && item.source === "edited" ? "edited" : "resume"
    }))
    : [];

  empty.extra = Array.isArray(value.extra)
    ? value.extra.map((item) => ({
      heading: strOrNull(item && item.heading) || "EXTRA",
      lines: Array.isArray(item && item.lines) ? item.lines.map((l) => String(l)) : []
    }))
    : [];

  return empty;
}

/**
 * A saved edit survives a re-parse because the saved object is what is kept.
 * Importing from the parse is a separate, one-item action; folding parsed
 * items back in here is how a person's title change would vanish on save.
 *
 * @param {object|null|undefined} saved
 * @param {object} parsed
 * @returns {object}
 */
export function mergeSections(saved, parsed) {
  if (saved != null) return structuredClone(saved);
  return structuredClone(parsed);
}

/**
 * Reorder a stored list. Returns a new array. A function that mutated the
 * DOM and left this array alone would pass a screenshot and fail the test
 * that reads what would be written.
 *
 * @param {Array<unknown>} list
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {Array<unknown>}
 */
export function moveItem(list, fromIndex, toIndex) {
  const next = Array.isArray(list) ? list.slice() : [];
  if (fromIndex === toIndex) return next;
  if (fromIndex < 0 || toIndex < 0) return next;
  if (fromIndex >= next.length || toIndex >= next.length) return next;
  const taken = next.splice(fromIndex, 1)[0];
  next.splice(toIndex, 0, taken);
  return next;
}

/**
 * Accept one suggested item. Never a bulk copy of the parse result -- a
 * parser that overwrites the section in one shot is the failure this exists
 * to prevent.
 *
 * @param {object} saved
 * @param {string} section
 * @param {object} item
 * @returns {object}
 */
export function acceptItem(saved, section, item) {
  const next = normalizeSections(saved);
  const list = next[section];
  if (!Array.isArray(list) || !item) return next;
  const fingerprint = itemFingerprint(item);
  if (list.some((existing) => itemFingerprint(existing) === fingerprint)) return next;
  list.push(item);
  next[section] = list.map((row, index) => {
    if (section === "experience") return normalizeExperienceItem(row, index);
    return row;
  });
  return next;
}

/**
 * @param {object} item
 * @returns {string}
 */
export function itemFingerprint(item) {
  if (!item || typeof item !== "object") return "";
  /* Content, not id: acceptItem assigns experience-0 on the way in, so
     comparing ids would treat the same company+title as a new role and
     duplicate it. */
  return [item.company, item.title, item.start, item.name, item.line, item.label, item.text]
    .map((v) => String(v || "").toLowerCase())
    .join("|");
}

/**
 * Remove anything that could be used to contact the person directly.
 *
 * Same rules as the original portfolio strip: an email or a phone number on
 * a public page is the failure, including when it sits inside a new field
 * (a role paragraph, a project blurb) rather than the old SUMMARY block.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripContact(text) {
  const NEWLINE = String.fromCharCode(10);
  return String(text || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "")
    .replace(/\+?\d{0,2}[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/g, "")
    .split(NEWLINE)
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .filter((line, i, all) => line !== "" || (i > 0 && i < all.length - 1))
    .join(NEWLINE)
    .trim();
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function scrubTree(value) {
  if (typeof value === "string") return stripContact(value);
  if (Array.isArray(value)) return value.map(scrubTree);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "visibility") {
        out[key] = child;
        continue;
      }
      out[key] = scrubTree(child);
    }
    return out;
  }
  return value;
}

/**
 * The public portfolio payload. Hidden sections are omitted as keys, not
 * sent as empty arrays and not sent with `hidden: true` -- a public page
 * that uses display:none still publishes the text to anything that reads
 * the HTML.
 *
 * @param {object} sections
 * @returns {object}
 */
export function publicView(sections) {
  const normalized = normalizeSections(sections);
  const vis = normalized.visibility;
  const out = { visibility: { ...vis } };
  if (vis.about && normalized.about) out.about = normalized.about;
  if (vis.experience) out.experience = normalized.experience;
  if (vis.projects) out.projects = normalized.projects;
  if (vis.skills) out.skills = normalized.skills;
  if (vis.education) out.education = normalized.education;
  if (vis.certifications) out.certifications = normalized.certifications;
  return /** @type {object} */ (scrubTree(out));
}

/**
 * Person JSON-LD written the way ingest/jd-read.mjs would want to read a
 * JobPosting: one `<script type="application/ld+json">` object, `@type` as
 * a string, related things as arrays of typed objects, no wrapping @graph
 * unless there are siblings. Email and telephone are never keys -- those
 * belong on an application, not a page anyone can scrape.
 *
 * @param {{
 *   name?: string|null,
 *   headline?: string|null,
 *   location?: string|null,
 *   url?: string|null,
 *   links?: {linkedin?: string|null, github?: string|null},
 *   experience?: Array<{company?: string|null, current?: boolean}>,
 *   education?: Array<{parts?: string[], line?: string}>
 * }} pub
 * @returns {object}
 */
export function personJsonLd(pub) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Person"
  };
  if (pub && pub.name) ld.name = String(pub.name);
  if (pub && pub.headline) ld.jobTitle = String(pub.headline);
  if (pub && pub.url) ld.url = String(pub.url);
  if (pub && pub.location) {
    ld.address = { "@type": "PostalAddress", addressLocality: String(pub.location) };
  }
  const sameAs = [];
  if (pub && pub.links && pub.links.linkedin) sameAs.push(String(pub.links.linkedin));
  if (pub && pub.links && pub.links.github) sameAs.push(String(pub.links.github));
  if (sameAs.length) ld.sameAs = sameAs;

  const worksFor = [];
  for (const role of (pub && pub.experience) || []) {
    if (role && role.current && role.company) {
      worksFor.push({ "@type": "Organization", name: String(role.company) });
    }
  }
  if (worksFor.length) ld.worksFor = worksFor;

  const alumniOf = [];
  for (const row of (pub && pub.education) || []) {
    const name = (row && row.parts && row.parts[0]) || (row && row.line);
    if (name) alumniOf.push({ "@type": "EducationalOrganization", name: String(name) });
  }
  if (alumniOf.length) ld.alumniOf = alumniOf;

  return ld;
}

/**
 * Column rows from a PRAGMA table_info response, whichever shape the runner
 * returned. Same failing input as ingest/pay-columns.mjs: a Workers `.all()`
 * envelope used to yield no names, so every re-run ALTERed.
 *
 * @param {any} raw
 * @returns {Array<{name: string}>}
 */
export function pragmaColumns(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.results)) return raw.results;
  if (raw && raw.result && raw.result[0] && Array.isArray(raw.result[0].results)) {
    return raw.result[0].results;
  }
  return [];
}

/**
 * @param {unknown} error
 * @param {string} column
 * @returns {boolean}
 */
export function isDuplicateColumnError(error, column) {
  const msg = String(error && (/** @type {{message?: string}} */ (error).message || error));
  return /duplicate column name/i.test(msg) && msg.includes(column);
}

/**
 * Add profile_sections if it is missing. Re-running against a database that
 * already has it is not an error -- a second ALTER on a live database is how
 * a deploy against an already-migrated table used to 500.
 *
 * @param {(sql: string, params?: Array<string|number|null>) => Promise<any>} run
 * @returns {Promise<void>}
 */
export async function ensureProfileColumns(run) {
  const raw = await run("PRAGMA table_info(profile)", []);
  const cols = pragmaColumns(raw);
  const have = new Set(cols.map((c) => c.name));
  if (have.has("profile_sections")) return;
  try {
    await run("ALTER TABLE profile ADD COLUMN profile_sections TEXT", []);
  } catch (error) {
    if (!isDuplicateColumnError(error, "profile_sections")) throw error;
  }
}

/**
 * Turn a parse result into the stored sections shape, still tagged as a
 * suggestion. The editor uses this only to preview an import, never as an
 * implicit write.
 *
 * @param {ReturnType<typeof parseResume>} parsed
 * @returns {object}
 */
export function sectionsFromParse(parsed) {
  const empty = emptySections();
  if (!parsed) return empty;
  empty.about = parsed.summary
    ? { text: parsed.summary, source: "resume" }
    : null;
  empty.experience = (parsed.experience || []).map(normalizeExperienceItem);
  empty.projects = (parsed.projects || []).map((item, index) => ({
    id: "project-" + index,
    name: item.name || "",
    paragraphs: item.paragraphs || [],
    url: item.url || null,
    source: "resume"
  }));
  empty.skills = (parsed.skills || []).map((item, index) => ({
    id: "skill-" + index,
    label: item.label,
    text: item.text,
    source: "resume"
  }));
  empty.education = (parsed.education || []).map((item, index) => ({
    id: "education-" + index,
    line: item.line,
    parts: item.parts,
    source: "resume"
  }));
  empty.certifications = (parsed.certifications || []).map((item, index) => ({
    id: "cert-" + index,
    line: item.line,
    parts: item.parts,
    source: "resume"
  }));
  empty.extra = parsed.extra || [];
  return empty;
}
