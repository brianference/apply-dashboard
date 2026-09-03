/**
 * The resume parser has to fail on THIS document's grammar, not on a
 * generic resume someone imagined.
 *
 * The D1 resume is 10,992 characters, 61 non-empty lines, with ALL-CAPS
 * headings and WORK EXPERIENCE roles of "Title | Company" + a date line +
 * "Mon YYYY to Present" + prose paragraphs. There are zero bullet lines,
 * and none of the nine year-bearing lines match `YYYY - YYYY`. A parser
 * written from memory stores empty roles for this person.
 *
 *   node ingest/test-profile-parse.mjs
 *
 * Known-bad: each rule is broken in a TEMPORARY COPY, never in the working
 * tree, and the same assertion is required to fail on that copy.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseResume,
  mergeSections,
  moveItem,
  acceptItem,
  publicView,
  personJsonLd,
  stripContact,
  normalizeSections,
  CURRENT_END,
  DATE_LINE,
  linesToParagraphs,
  parseDateLine,
  ensureProfileColumns,
  pragmaColumns,
  isDuplicateColumnError,
  sectionsFromParse
} from './profile-parse.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(78)} ${detail || ''}`);
}

/**
 * Prose of a known length in the 200-360 window the real roles use.
 *
 * @param {number} n
 * @param {string} seed
 * @returns {string}
 */
function prose(n, seed) {
  const unit = seed + " ";
  let out = "";
  while (out.length < n) out += unit;
  return out.slice(0, n).trim();
}

const CURRENT_PARA = prose(240,
  "Led the product organisation through a full rebuild of the valuation platform, putting machine learning into the same workflow the analysts already used rather than a side tool they had to remember");
const CURRENT_PARA_2 = prose(220,
  "Shipped the client portal that cut a week of email out of every filing cycle and wrote the success criteria before the first ticket so engineering and CS scored the same thing");
const PAST_PARA = prose(260,
  "Owned the analytics suite from roadmap through launch, including the first LLM-assisted report writer that customers actually turned on instead of a demo that never left the lab");

check('current-role paragraph is in the measured 200-360 window',
  CURRENT_PARA.length >= 200 && CURRENT_PARA.length <= 360,
  String(CURRENT_PARA.length));
check('second current-role paragraph is in the measured 200-360 window',
  CURRENT_PARA_2.length >= 200 && CURRENT_PARA_2.length <= 360,
  String(CURRENT_PARA_2.length));
check('past-role paragraph is in the measured 200-360 window',
  PAST_PARA.length >= 200 && PAST_PARA.length <= 360,
  String(PAST_PARA.length));

const TITLE_CURRENT = "Senior AI Product Manager | Equity Methods";
const TITLE_PAST = "AI Product Manager, Educational and Marketing Video | The Institutes";
check('current title|company line is in the measured 42-68 window',
  TITLE_CURRENT.length >= 42 && TITLE_CURRENT.length <= 68,
  String(TITLE_CURRENT.length));
check('past title|location line is in the measured 42-68 window',
  TITLE_PAST.length >= 42 && TITLE_PAST.length <= 68,
  String(TITLE_PAST.length));

const DATE_CURRENT = "Jan 2024 to Present";
const DATE_PAST = "Mar 2020 to Dec 2023";
check('current date line is 19 characters', DATE_CURRENT.length === 19, String(DATE_CURRENT.length));
check('past date line is 20 characters', DATE_PAST.length === 20, String(DATE_PAST.length));

/* The company is the right of the pipe, not a line of its own. */
const COMPANY = "Equity Methods";
/* The 15-character company line the first version of this fixture had does
   not exist in the document. The company arrives inside the pipe line, so
   its length is asserted there. */

const FIXTURE_PROSE = [
  "BRIAN FERENCE",
  "Phoenix, AZ",
  "leak@example.com",
  "+1 (555) 123-4567",
  "",
  "SUMMARY",
  "A product manager who ships LLM systems into production and the products around them.",
  "",
  "WORK EXPERIENCE",
  TITLE_CURRENT,
  DATE_CURRENT,
  CURRENT_PARA,
  "",
  CURRENT_PARA_2,
  "",
  TITLE_PAST,
  DATE_PAST,
  PAST_PARA,
  "",
  "Owner, Web Design Company | Web Site AZ LLC",
  "2016 to Present",
  "Built and maintained sites for small Arizona businesses, handling hosting, content and the occasional emergency restore, alongside a full-time role throughout.",
  "",
  "SELECTED PROJECTS",
  "RedAnvil",
  "An app factory that turns a prompt into a running product with a database, API and tests.",
  "",
  "SKILLS",
  "Product: roadmaps, experimentation, discovery, pricing",
  "Technical: SQL, Python, LLMs, evaluation",
  "",
  "EDUCATION",
  "State University | MBA | 2012",
  "State University | BS Computer Science | 2008",
  "",
  "CERTIFICATIONS",
  "Cloud Practitioner | Amazon | 2023",
  "",
  "PUBLICATIONS",
  "A paper nobody asked the parser to know about",
  "Still here rather than discarded"
].join("\n");

check('the prose fixture has zero bullet/dash/asterisk-prefixed lines',
  FIXTURE_PROSE.split("\n").every((line) => !/^[\u2022\u2013\u2014*\-]\s/.test(line.trim())));
check('no line matches the naive YYYY - YYYY shape',
  !FIXTURE_PROSE.split("\n").some((line) => /\d{4}\s*-\s*\d{4}/.test(line)));

const parsed = parseResume(FIXTURE_PROSE);

check('role count is 3', parsed.experience.length === 3, String(parsed.experience.length));

const current = parsed.experience[0];
check('current role company', current && current.company === COMPANY, current && current.company);
check('current role title',
  current && current.title === "Senior AI Product Manager", current && current.title);
/* The pipe carries "Title | Company". This resume states no location at all,
   so location is null rather than invented -- the earlier version asserted a
   location the document never contained, and the parser obligingly produced
   one by putting the company there. */
check('current role location is null, because the document has none',
  current && current.location === null, JSON.stringify(current && current.location));
check('current role start is Jan 2024',
  current && current.start === "Jan 2024", current && current.start);
check('current role end is null, not Present and not a date',
  current && current.end === null && current.end === CURRENT_END,
  current ? JSON.stringify(current.end) : "no role");
check('current role current=true', current && current.current === true);
check('current role has prose paragraphs, not an empty bullet list',
  current && current.paragraphs.length >= 2
    && current.paragraphs[0].length >= 200
    && current.paragraphs.every((p) => !/^[\u2022\u2013\u2014*\-]/.test(p)),
  current ? String(current.paragraphs.length) + " paras, first " + (current.paragraphs[0] || "").length : "");
check('current role is tagged source=resume until edited',
  current && current.source === "resume");

const past = parsed.experience[1];
check('past role title', past && past.title === "AI Product Manager, Educational and Marketing Video", past && past.title);
check('past role end is Dec 2023, not null',
  past && past.end === "Dec 2023" && past.current === false, past && past.end);

check('summary is the SUMMARY section, not the name line',
  parsed.summary.indexOf("LLM systems") !== -1
    && parsed.summary.indexOf("BRIAN FERENCE") === -1);
check('name is taken from the first identity heading',
  parsed.name === "BRIAN FERENCE");
check('projects parse the first line as the name',
  parsed.projects.length === 1 && parsed.projects[0].name === "RedAnvil");
check('skills keep the label before the colon',
  parsed.skills.length === 2 && parsed.skills[0].label === "Product");
check('education keeps pipe parts without inventing field names',
  parsed.education.length === 2 && parsed.education[0].parts[0] === "State University"
    && parsed.education[0].parts[1] === "MBA");

const extra = parsed.extra.find((e) => e.heading === "PUBLICATIONS");
check('unknown heading PUBLICATIONS survives as extra rather than vanishing',
  !!(extra && extra.lines.some((l) => /paper nobody asked/.test(l))),
  extra ? JSON.stringify(extra.lines) : "no extra");
check('unknown heading is not folded into certifications',
  parsed.certifications.every((c) => c.line.indexOf("paper nobody") === -1));

/* ---- bullets AND no-bullets both parse -------------------------------- */

const FIXTURE_BULLETS = [
  "BRIAN FERENCE",
  "",
  "WORK EXPERIENCE",
  TITLE_CURRENT,
  DATE_CURRENT,
  "- Led the product organisation through a full rebuild of the valuation platform",
  "* Put machine learning into the same workflow the analysts already used",
  "• Wrote the success criteria before the first ticket",
  "",
  TITLE_PAST,
  DATE_PAST,
  "- Owned the analytics suite from roadmap through launch"
].join("\n");

const withBullets = parseResume(FIXTURE_BULLETS);
check('a resume with bullets still yields 2 roles',
  withBullets.experience.length === 2, String(withBullets.experience.length));
check('bullet lines become paragraphs, stripped of the marker',
  withBullets.experience[0].paragraphs.length === 3
    && withBullets.experience[0].paragraphs[0].indexOf("Led the product") === 0
    && withBullets.experience[0].paragraphs.every((p) => !/^[\u2022\u2013\u2014*\-]/.test(p)),
  JSON.stringify(withBullets.experience[0].paragraphs));
check('the no-bullet fixture is the one that matches the real document',
  parseResume(FIXTURE_PROSE).experience[0].paragraphs.length >= 2);

/* ---- unparseable keeps raw -------------------------------------------- */

const messy = parseResume([
  "WORK EXPERIENCE",
  "a leftover block",
  "that has no date line",
  "and no pipe"
].join("\n"));
check('an unparseable role keeps raw lines rather than going missing',
  messy.experience.length === 1
    && Array.isArray(messy.experience[0].raw)
    && messy.experience[0].raw.join(" ").indexOf("leftover block") !== -1,
  JSON.stringify(messy.experience[0]));
check('an unparseable role does not invent a company',
  messy.experience[0].company === null);
check('an unparseable role does not invent an end date',
  messy.experience[0].end === null);

check('a missing end date from parseDateLine of Present is null',
  parseDateLine(DATE_CURRENT).end === null
    && parseDateLine(DATE_CURRENT).current === true);
check('DATE_LINE accepts Mon YYYY to Present', DATE_LINE.test(DATE_CURRENT));
check('DATE_LINE rejects YYYY - YYYY', DATE_LINE.test("2020 - 2024") === false);

/* ---- saved edit survives a re-parse ----------------------------------- */

const first = parseResume(FIXTURE_PROSE);
const edited = structuredClone(first);
edited.experience[0].title = "Edited Title";
edited.experience[0].source = "edited";
const again = parseResume(FIXTURE_PROSE);
const merged = mergeSections(edited, again);
check('a saved title edit survives a re-parse',
  merged.experience[0].title === "Edited Title",
  merged.experience[0].title);
check('the re-parse by itself still has the resume title, so the merge is what kept the edit',
  again.experience[0].title === "Senior AI Product Manager");
check('mergeSections(null, parsed) returns the parse so a first import still works',
  mergeSections(null, first).experience[0].title === "Senior AI Product Manager");

/* ---- accept one item, never a bulk overwrite -------------------------- */

const emptySaved = normalizeSections(null);
const one = acceptItem(emptySaved, "experience", first.experience[0]);
const two = acceptItem(one, "experience", first.experience[1]);
check('acceptItem adds one role at a time',
  one.experience.length === 1 && two.experience.length === 2,
  `${one.experience.length} then ${two.experience.length}`);
check('acceptItem does not duplicate a role already saved',
  acceptItem(two, "experience", first.experience[0]).experience.length === 2);

/* ---- reorder changes the stored array --------------------------------- */

const reordered = moveItem(two.experience, 0, 1);
check('moveItem changes the stored order, not just a display index',
  reordered[0].title === first.experience[1].title
    && reordered[1].title === first.experience[0].title,
  reordered.map((r) => r.title).join(" | "));
check('moveItem returns a new array', reordered !== two.experience);
check('the original saved order is unchanged until the caller writes it',
  two.experience[0].title === first.experience[0].title);

/* ---- visibility omits the key ----------------------------------------- */

const stored = sectionsFromParse(first);
stored.visibility.experience = false;
stored.experience[0].paragraphs[0] = "Call leak@example.com or +1 (555) 123-4567 inside a role.";
stored.about = {
  text: "Reach me at leak@example.com or +1 (555) 987-6543.",
  source: "edited"
};
const published = publicView(stored);
check('a hidden experience section is absent from the public object, not display:none',
  !Object.prototype.hasOwnProperty.call(published, "experience"),
  Object.keys(published).join(","));
check('a visible about section is present',
  Object.prototype.hasOwnProperty.call(published, "about"));
check('public view strips email from about',
  published.about && published.about.text.indexOf("leak@example.com") === -1,
  published.about && published.about.text);
check('public view strips a phone number from about',
  published.about && !/\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/.test(published.about.text),
  published.about && published.about.text);

stored.visibility.experience = true;
const publishedExp = publicView(stored);
check('a visible experience section is present so hiding is not "never render"',
  Array.isArray(publishedExp.experience) && publishedExp.experience.length === 3);
check('public view strips email from a role paragraph',
  publishedExp.experience[0].paragraphs.every((p) => p.indexOf("leak@example.com") === -1));

check('stripContact removes an email',
  stripContact("write leak@example.com today").indexOf("leak@example.com") === -1);
check('stripContact removes a US phone',
  !/\d{3}/.test(stripContact("call +1 (555) 123-4567 now").replace(/\s/g, ""))
    || stripContact("call +1 (555) 123-4567 now").indexOf("555") === -1,
  stripContact("call +1 (555) 123-4567 now"));

/* ---- JSON-LD Person --------------------------------------------------- */

const ld = personJsonLd({
  name: "Brian Ference",
  headline: "AI Product Manager",
  location: "Phoenix, AZ",
  url: "https://apply-dashboard.pages.dev/portfolio/brian",
  links: {
    linkedin: "https://www.linkedin.com/in/brianference",
    github: "https://github.com/brianference"
  },
  experience: publishedExp.experience,
  education: stored.education
});
check('JSON-LD @type is Person as a string, the way a JobPosting reader looks up @type',
  ld["@type"] === "Person");
check('JSON-LD @context is schema.org',
  ld["@context"] === "https://schema.org");
check('JSON-LD worksFor lists the current employer',
  Array.isArray(ld.worksFor)
    && ld.worksFor.some((o) => o["@type"] === "Organization" && o.name === COMPANY),
  JSON.stringify(ld.worksFor));
check('JSON-LD alumniOf lists education',
  Array.isArray(ld.alumniOf)
    && ld.alumniOf.some((o) => o["@type"] === "EducationalOrganization"
      && o.name === "State University"),
  JSON.stringify(ld.alumniOf));
check('JSON-LD has no email key', !Object.prototype.hasOwnProperty.call(ld, "email"));
check('JSON-LD has no telephone key', !Object.prototype.hasOwnProperty.call(ld, "telephone"));
check('JSON-LD body has no leak address',
  JSON.stringify(ld).indexOf("leak@example.com") === -1);

/* ---- normalize refuses Present as an end date ------------------------- */

const forced = normalizeSections({
  experience: [{
    company: COMPANY, title: "X", location: "Y",
    start: "Jan 2024", end: "Present", current: true, paragraphs: ["p"]
  }]
});
check('normalizeSections stores null rather than Present for a current role',
  forced.experience[0].end === null, String(forced.experience[0].end));

/* ---- ensureProfileColumns --------------------------------------------- */

check('pragmaColumns reads a raw array',
  pragmaColumns([{ name: "profile_sections" }]).map((c) => c.name).join(",") === "profile_sections");
check('pragmaColumns reads Workers .all() shape',
  pragmaColumns({ results: [{ name: "profile_sections" }], success: true, meta: {} })
    .map((c) => c.name).join(",") === "profile_sections");
check('duplicate column name: profile_sections is swallowed',
  isDuplicateColumnError(new Error("duplicate column name: profile_sections"), "profile_sections") === true);
check('no such table: profile is not a duplicate-column error',
  isDuplicateColumnError(new Error("no such table: profile"), "profile_sections") === false);

let alters = 0;
await ensureProfileColumns(async (sql) => {
  if (String(sql).startsWith("PRAGMA")) {
    return { results: [{ name: "handle" }, { name: "profile_sections" }], success: true, meta: {} };
  }
  alters += 1;
  throw new Error("duplicate column name: profile_sections");
});
check('Workers .all() with profile_sections present does not ALTER', alters === 0);

let missingAlters = 0;
await ensureProfileColumns(async (sql) => {
  if (String(sql).startsWith("PRAGMA")) return { results: [{ name: "handle" }], success: true, meta: {} };
  missingAlters += 1;
  if (!/ADD COLUMN profile_sections TEXT/.test(String(sql))) {
    throw new Error("unexpected sql " + sql);
  }
});
check('missing profile_sections issues one ALTER TABLE profile ADD COLUMN',
  missingAlters === 1);

let dupAlters = 0;
await ensureProfileColumns(async (sql) => {
  if (String(sql).startsWith("PRAGMA")) return { results: [], success: true, meta: {} };
  dupAlters += 1;
  throw new Error("duplicate column name: profile_sections");
});
check('unreadable pragma still tolerates duplicate-column ALTER', dupAlters === 1);

let otherErr = null;
try {
  await ensureProfileColumns(async (sql) => {
    if (String(sql).startsWith("PRAGMA")) return [];
    throw new Error("no such table: profile");
  });
} catch (error) {
  otherErr = error;
}
check('non-duplicate ALTER error is rethrown',
  !!(otherErr && /no such table: profile/.test(otherErr.message)));

/* ---- linesToParagraphs does not require bullets ----------------------- */

check('linesToParagraphs keeps a 240-char prose line as one paragraph',
  linesToParagraphs([CURRENT_PARA]).length === 1
    && linesToParagraphs([CURRENT_PARA])[0].length === CURRENT_PARA.length);

/* ====================================================================== */
/* Known-bad: TEMP COPIES, never the working tree.                        */
/* ====================================================================== */

const implPath = path.join(ROOT, "functions", "api", "_profile-parse.js");
const src = fs.readFileSync(implPath, "utf8");
const tmpBreak = fs.mkdtempSync(path.join(os.tmpdir(), "profile-parse-break-"));
const functionsUrl = pathToFileURL(path.join(ROOT, "functions", "api")).href.replace(/\/$/, "");

/**
 * @param {string} mutated
 * @param {string} name
 * @returns {Promise<object>}
 */
async function loadBroken(mutated, name) {
  const p = path.join(tmpBreak, name);
  fs.writeFileSync(p, mutated.replace(/from '\.\//g, `from '${functionsUrl}/`));
  return import(pathToFileURL(p).href + "?t=" + Date.now() + Math.random());
}

{
  const broken = await loadBroken(
    src.replace(
      "const end = current ? CURRENT_END : join(match[4], match[5]);",
      "const end = current ? \"Present\" : join(match[4], match[5]);"
    ),
    "end-present.mjs"
  );
  const role = broken.parseResume(FIXTURE_PROSE).experience[0];
  check('TEMP COPY that stores Present as end FAILS the null-end assertion',
    !(role.end === null),
    "end=" + JSON.stringify(role.end));
}

{
  const broken = await loadBroken(
    src.replace(
      "if (saved != null) return structuredClone(saved);\n  return structuredClone(parsed);",
      "return structuredClone(parsed);"
    ),
    "merge-overwrites.mjs"
  );
  const keep = structuredClone(first);
  keep.experience[0].title = "Edited Title";
  const lost = broken.mergeSections(keep, parseResume(FIXTURE_PROSE));
  check('TEMP COPY that returns the re-parse FAILS the saved-edit assertion',
    lost.experience[0].title !== "Edited Title",
    lost.experience[0].title);
}

{
  const broken = await loadBroken(
    src.replace(
      "else out.extra.push({ heading: block.heading, lines: intactLines(block.lines) });",
      "else { /* unknown headings discarded */ }"
    ),
    "drop-extra.mjs"
  );
  const dropped = broken.parseResume(FIXTURE_PROSE);
  check('TEMP COPY that drops unknown headings FAILS the extra assertion',
    !dropped.extra.some((e) => e.heading === "PUBLICATIONS"),
    JSON.stringify(dropped.extra));
}

{
  const broken = await loadBroken(
    src.replace(
      "if (!trimmed) {\n      flush();\n      continue;\n    }\n    if (BULLET.test(trimmed)) {\n      flush();\n      paragraphs.push(trimmed.replace(BULLET, \"\").trim());\n      continue;\n    }\n    buf.push(trimmed);",
      "if (BULLET.test(trimmed)) {\n      paragraphs.push(trimmed.replace(BULLET, \"\").trim());\n    }"
    ),
    "bullets-only.mjs"
  );
  const roles = broken.parseResume(FIXTURE_PROSE).experience;
  check('TEMP COPY that only splits on bullets FAILS the prose-paragraph assertion',
    !(roles[0] && roles[0].paragraphs.length >= 2),
    roles[0] ? String(roles[0].paragraphs.length) : "no role");
  check('TEMP COPY that only splits on bullets still parses the bullet fixture (so the break is the missing prose path)',
    broken.parseResume(FIXTURE_BULLETS).experience[0].paragraphs.length >= 1);
}

{
  const naiveDate = src
    .replace(
      "export const DATE_LINE = new RegExp(\n  \"^(?:\" + MONTH + \") \\\\d{4} to (?:Present|(?:\" + MONTH + \") \\\\d{4})$\"\n);",
      "export const DATE_LINE = /\\d{4}\\s*-\\s*\\d{4}/;"
    )
    .replace(
      "const DATE_PARTS = new RegExp(\n  \"^(\" + MONTH + \") (\\\\d{4}) to (Present|(\" + MONTH + \") (\\\\d{4}))$\"\n);",
      "const DATE_PARTS = /(\\d{4})\\s*-\\s*(\\d{4}|Present)/;"
    );
  const broken = await loadBroken(naiveDate, "yyyy-yyyy.mjs");
  const roles = broken.parseResume(FIXTURE_PROSE).experience;
  check('TEMP COPY that looks for YYYY - YYYY FAILS the role-count assertion',
    roles.length !== 2,
    "roles=" + roles.length);
}

{
  const broken = await loadBroken(
    src.replace(
      "const taken = next.splice(fromIndex, 1)[0];\n  next.splice(toIndex, 0, taken);\n  return next;",
      "return next;"
    ),
    "reorder-noop.mjs"
  );
  const moved = broken.moveItem(two.experience, 0, 1);
  check('TEMP COPY that does not splice FAILS the stored-order assertion',
    moved[0].title === two.experience[0].title,
    moved[0].title);
}

{
  const broken = await loadBroken(
    src.replace(
      "if (vis.experience) out.experience = normalized.experience;",
      "out.experience = normalized.experience;"
    ),
    "always-publish.mjs"
  );
  const hidden = sectionsFromParse(first);
  hidden.visibility.experience = false;
  const pub = broken.publicView(hidden);
  check('TEMP COPY that still sends experience FAILS the absent-key assertion',
    Object.prototype.hasOwnProperty.call(pub, "experience"));
}

{
  const broken = await loadBroken(
    src.replace(
      "if (alumniOf.length) ld.alumniOf = alumniOf;\n\n  return ld;",
      "if (alumniOf.length) ld.alumniOf = alumniOf;\n  ld.email = \"leak@example.com\";\n  ld.telephone = \"+1-555-123-4567\";\n  return ld;"
    ),
    "jsonld-contact.mjs"
  );
  const leak = broken.personJsonLd({
    name: "X",
    experience: [{ company: COMPANY, current: true }],
    education: [{ parts: ["State University"] }]
  });
  check('TEMP COPY that puts email on Person FAILS the no-email assertion',
    Object.prototype.hasOwnProperty.call(leak, "email"));
  check('TEMP COPY that puts telephone on Person FAILS the no-telephone assertion',
    Object.prototype.hasOwnProperty.call(leak, "telephone"));
}

const profileSrc = fs.readFileSync(path.join(ROOT, "functions", "api", "profile.js"), "utf8");
const putSrc = profileSrc.slice(profileSrc.indexOf("export async function onRequestPut"));
check("GET offers parseResume as suggested", /\bparseResume\s*\(/.test(profileSrc));
check("onRequestPut does not call parseResume -- a save must not overwrite edits",
  !/\bparseResume\s*\(/.test(putSrc));

const webParse = fs.readFileSync(path.join(ROOT, "web", "profile", "js", "parse.js"), "utf8");
check('web/profile/js/parse.js is the same parser the Function imports -- two copies cannot drift',
  webParse === src);

check('the real module still has a null end after the copies were broken',
  parseResume(FIXTURE_PROSE).experience[0].end === null);
check('the real module still keeps PUBLICATIONS as extra after the copies were broken',
  parseResume(FIXTURE_PROSE).extra.some((e) => e.heading === "PUBLICATIONS"));


/* ---- nothing in WORK EXPERIENCE is silently dropped --------------------

   The first version of this parser looked upward from each date line for a
   separate company line. There is no such line -- the company is the right of
   the pipe -- so it claimed the preceding PARAGRAPH instead, and then used that
   index as the end of the previous role. Eight long lines of achievement text
   stopped landing anywhere, and every assertion still passed, because text that
   is never assigned leaves nothing to assert against.

   This is the shape of check that would have caught it: account for every
   source line rather than spot-checking the fields that happen to be named. */
{
  const lines = FIXTURE_PROSE.split("\n").map((l) => l.trim()).filter(Boolean);
  const start = lines.indexOf("WORK EXPERIENCE");
  const heads = new Set(["SELECTED PROJECTS", "SKILLS", "EDUCATION", "CERTIFICATIONS"]);
  let stop = lines.length;
  for (let k = start + 1; k < lines.length; k++) if (heads.has(lines[k])) { stop = k; break; }
  const source = lines.slice(start + 1, stop);

  const captured = parsed.experience.flatMap((e) => [
    (e.title || "") + " | " + (e.company || ""),
    e.start || "",
    ...(e.paragraphs || []),
    ...(e.raw || [])
  ]).join("\n");

  const missing = source.filter((l) => l.length > 40 && captured.indexOf(l.slice(0, 40)) === -1);
  check('every WORK EXPERIENCE line lands in a role, a paragraph or raw',
    missing.length === 0, missing.slice(0, 2).join(' || ') || `${source.length} lines accounted for`);

  const paras = parsed.experience.reduce((n, e) => n + (e.paragraphs || []).length, 0);
  check('paragraph count is not zero, which is what an unmatched grammar looks like',
    paras > 0, String(paras));
}


/* ---- auto-import, without ever overwriting saved work ------------------

   Brian, 2026-09-03: do not force them to hit import on each section, just
   auto-import and let them edit. The friction goes; the safety property must
   not. mergeSections is the primitive both behaviours rest on, so both are
   asserted here rather than only the new one. */
{
  const parsed = parseResume(FIXTURE_PROSE);

  /* First visit: nothing stored, so the parse IS the starting state. */
  const first = mergeSections(null, parsed);
  check('a first visit starts from the parse, not an empty form',
    first && Array.isArray(first.experience) && first.experience.length === parsed.experience.length,
    first && first.experience && String(first.experience.length));

  /* A later visit: something stored, so the parse must not be applied over it.
     This is the case that protects a person's edits, and it is the reason the
     auto-fill is gated on "nothing stored" rather than run on every load. */
  const edited = structuredClone(first);
  edited.experience[0].title = "Head of Product, edited by hand";
  const later = mergeSections(edited, parsed);
  check('a later visit keeps the edit rather than re-importing over it',
    later.experience[0].title === "Head of Product, edited by hand",
    later.experience[0].title);
  check('and the parse by itself still carries the resume title, so the merge is what kept it',
    parsed.experience[0].title !== "Head of Product, edited by hand",
    parsed.experience[0].title);

  /* An empty stored object is still "stored". Treating {} as nothing would
     re-import over somebody who had deliberately cleared a section. */
  const cleared = structuredClone(first);
  cleared.experience = [];
  const afterClear = mergeSections(cleared, parsed);
  check('a deliberately emptied section is not refilled by the parse',
    Array.isArray(afterClear.experience) && afterClear.experience.length === 0,
    String(afterClear.experience.length));
}

console.log(bad ? `\n${bad} FAILED` : "\nresume parse holds on the grammar measured from the document");
process.exitCode = bad ? 1 : 0;
