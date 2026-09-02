/**
 * Greenhouse HTML has to become a range salaryFromText can read.
 *
 * MongoDB job 8143805 published $126,000-$248,000 and the pipeline stored
 * neither figure, because strip() left `&lt;span&gt;` and `&mdash;` between
 * them. Each case here is a shape that decoder has to handle, plus the
 * inputs that prove it is not "return a number for everything" and not an
 * infinite loop.
 *
 *   node ingest/test-strip.mjs
 */

import { strip, decodeHtmlEntities, STRIP_MAX_PASSES } from './fit-score.mjs';
import { salaryFromText } from './salary-from-posting.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(62)} ${detail || ''}`);
}

/**
 * @param {string} html
 * @returns {{min: number|null, max: number|null}}
 */
function pipeline(html) {
  return salaryFromText(strip(html));
}

/* The real Greenhouse `content` field for MongoDB 8143805, measured
   2026-09-02 against https://boards-api.greenhouse.io/v1/boards/mongodb/jobs/8143805?content=true
   Tags are already `&lt;span&gt;`; the dash is `&amp;mdash;` -- two layers,
   which is why one decode still left a separator the extractor cannot read. */
const MONGODB_DOUBLE =
  '&lt;div class=&quot;pay-range&quot;&gt;&lt;span&gt;$126,000&lt;/span&gt;&lt;span class=&quot;divider&quot;&gt;&amp;mdash;&lt;/span&gt;&lt;span&gt;$248,000 USD&lt;/span&gt;&lt;/div&gt;';

/* The stripped-but-still-escaped form measured on that job: real tags gone,
   escaped ones surviving, figures 91 characters apart. */
const MONGODB_STRIPPED_ESCAPED =
  '$126,000&lt;/span&gt;&lt;span class=&quot;divider&quot;&gt;&mdash;&lt;/span&gt;&lt;span&gt;$248,000';

const SINGLY =
  '<div class="pay-range"><span>$126,000</span><span class="divider">&mdash;</span><span>$248,000 USD</span></div>';

const CLEAN =
  '<div class="pay-range"><span>$126,000</span><span class="divider">-</span><span>$248,000 USD</span></div>';

const mongoDouble = pipeline(MONGODB_DOUBLE);
check('double-escaped MongoDB pay block -> 126000/248000 through strip then salaryFromText',
  mongoDouble.min === 126000 && mongoDouble.max === 248000,
  `got ${mongoDouble.min}-${mongoDouble.max}`);

const mongoEscaped = pipeline(MONGODB_STRIPPED_ESCAPED);
check('measured escaped-surviving form -> 126000/248000 through strip then salaryFromText',
  mongoEscaped.min === 126000 && mongoEscaped.max === 248000,
  `got ${mongoEscaped.min}-${mongoEscaped.max}`);

const singly = pipeline(SINGLY);
check('singly-escaped pay block -> 126000/248000',
  singly.min === 126000 && singly.max === 248000,
  `got ${singly.min}-${singly.max}`);

const clean = pipeline(CLEAN);
check('clean HTML pay block -> 126000/248000',
  clean.min === 126000 && clean.max === 248000,
  `got ${clean.min}-${clean.max}`);

/* Decode order: amp last. If amp is decoded first, `&amp;lt;` becomes `<`
   in one pass and the loop's stability check thinks there is nothing left
   to do. */
check('&amp;lt; decodes to &lt; in one pass, not <',
  decodeHtmlEntities('&amp;lt;') === '&lt;',
  JSON.stringify(decodeHtmlEntities('&amp;lt;')));
check('a second pass then yields <',
  decodeHtmlEntities(decodeHtmlEntities('&amp;lt;')) === '<');

const empty = pipeline(
  '<p>We offer competitive compensation, equity, and health benefits. Come join us.</p>'
);
check('a posting with no band returns null, not a guessed figure',
  empty.min === null && empty.max === null,
  `got ${empty.min}-${empty.max}`);

check('STRIP_MAX_PASSES is a small finite cap',
  Number.isInteger(STRIP_MAX_PASSES) && STRIP_MAX_PASSES > 0 && STRIP_MAX_PASSES <= 32,
  String(STRIP_MAX_PASSES));

let nested = '$180,000';
for (let i = 0; i < 40; i++) {
  nested = `&amp;lt;span&amp;gt;${nested}&amp;lt;/span&amp;gt;`;
}
const started = Date.now();
let nestedOut = null;
let nestedThrew = null;
try {
  nestedOut = strip(nested);
} catch (error) {
  nestedThrew = error && error.message ? error.message : String(error);
}
const elapsed = Date.now() - started;
check('deeply nested escaping terminates, does not hang',
  nestedThrew === null && typeof nestedOut === 'string' && elapsed < 2000,
  nestedThrew ? nestedThrew : `${elapsed}ms len=${nestedOut && nestedOut.length}`);

/* &#39; and &#x27; are the two apostrophe forms the boards actually send. */
check('&#39; and &#x27; both decode to an apostrophe',
  strip('it&#39;s') === "it's" && strip('it&#x27;s') === "it's",
  `${JSON.stringify(strip('it&#39;s'))} ${JSON.stringify(strip('it&#x27;s'))}`);

/* Block boundaries have to survive as a real separator. strip() used to
   replace every tag with a space and then collapse whitespace, so
   <h2>About the Job</h2><h2>Site Theming</h2> became "Job Site" and the
   construction rule's `job ?site` matched a heading pair that is not
   adjacent on the page. Instacart "Senior Product Manager, Retailer
   Platform" (Greenhouse 8014060) was ruled out for exactly that. */
const headings = strip('<h2>About the Job</h2><h2>Site Theming</h2>');
check('adjacent block headings do not produce "Job Site"',
  typeof headings === 'string' && !/job\s*site/i.test(headings) && /Job/i.test(headings) && /Site/i.test(headings),
  JSON.stringify(headings));

const instacartShape = strip(
  '&lt;h2&gt;About the Job&lt;/h2&gt;\n&lt;p&gt;Site Theming &amp;amp; Brand Platform&lt;/p&gt;'
);
check('escaped Instacart heading then paragraph does not produce "Job Site"',
  typeof instacartShape === 'string' && !/job\s*site/i.test(instacartShape),
  JSON.stringify(instacartShape));

/* Inline tags must still collapse, or a band published as three spans
   stops being a range the extractor can read. */
const inlineRange = strip('<span>$126,000</span><span>-</span><span>$248,000</span>');
const inlineBand = salaryFromText(inlineRange);
check('inline spans still collapse into one readable range 126000/248000',
  inlineBand.min === 126000 && inlineBand.max === 248000,
  `${JSON.stringify(inlineRange)} -> ${inlineBand.min}-${inlineBand.max}`);

console.log(bad ? `\n${bad} FAILED` : '\nstrip() turns double-escaped Greenhouse HTML into a range the extractor can read');
process.exitCode = bad ? 1 : 0;
