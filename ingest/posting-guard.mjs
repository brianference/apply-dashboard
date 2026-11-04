/**
 * Posting guard: screen untrusted third-party job text before it is scored or
 * handed to the assisted apply runner.
 *
 * A posting is written by a stranger and read next to Brian's resume and
 * answers. Nothing in ingest/ screened it. This is a deterministic, pure
 * pass that (1) strips characters a reader cannot see, (2) removes hidden
 * HTML if markup reaches it, and (3) FLAGS text that talks to an AI instead of
 * to a candidate. A flagged posting is returned in full; the guard advises and
 * never drops a row, because the cost of a false positive must be one line in a
 * log, not a missing job.
 *
 * Ideas follow ai-job-search-dev/ai-job-search tools/posting_guard.py (hidden
 * HTML, invisible characters, instruction-shaped lines). The code is original.
 * It is a tripwire for the obvious payload classes, not a proof of safety: a
 * paraphrase no pattern anticipates passes.
 *
 * Run the tests: node ingest/test-posting-guard.mjs
 */

const EVIDENCE_MAX = 120;

/* Zero-width, word joiner, invisible operators, soft hyphen, BOM, bidi
   embeddings/overrides/isolates, line and paragraph separators, and the
   Unicode "tag" block (one invisible code point per ASCII letter). */
const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\u00AD\uFEFF\u180E]/g;
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/g;
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
/* Bidi overrides, embeddings and isolates reorder what a reader sees; the
   plain direction marks (LRM, RLM, ALM) are ordinary in right-to-left text. */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/g;
/* A zero-width character with a letter or digit on each side, a ZWJ between
   emoji excepted. */
const INSIDE_WORD = /[\p{L}\p{N}][\u200B\u200C\u2060\u00AD\uFEFF\u180E]+(?=[\p{L}\p{N}])|[\p{L}\p{N}]\u200D+(?=[\p{L}\p{N}])/u;
const LONG_RUN = /[\u200B-\u200D\u2060-\u2064\u00AD\uFEFF\u180E]{4,}/;
const ZERO_WIDTH_TOTAL_MAX = 10;
const SEPARATORS = /[\u2028\u2029]/g;

/* Instruction-shaped text aimed at an AI rather than a reader. Matched on
   text with invisibles removed, whitespace collapsed (so a sentence split
   across lines still matches) and compatibility forms folded (NFKC). */
const INSTRUCTION_PATTERNS = [
  ['override', /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+|every\s+)?(?:(?:previous|prior|above|earlier|preceding|initial|original|system|other)\s+)?(?:instructions?|prompts?|rules|directions|guidelines|context|constraints)\b/i],
  ['override', /\bnew\s+instructions?\s*:/i],
  ['persona', /\byou\s+are\s+now\b/i],
  ['persona', /\byou\s+are\s+(?:an?|the)\s+(?:(?:ai|llm)(?:\s+(?:assistant|agent|model|bot|system)\b|(?=\s*(?:[.,;:!]|$)))|language\s+model|assistant\b|chatbot|recruiting\s+(?:bot|assistant))/i],
  ['persona', /\b(?:act|behave|respond)\s+as\s+(?:an?|the)\s+(?:ai|llm|chatbot|bot|language\s+model|unrestricted|jailbroken)\b(?!\s*(?:-|native))/i],
  ['system-prompt', /\bsystem\s+prompt\b/i],
  ['as-an-ai', /\bas\s+an?\s+(?:ai|llm)\s+(?:language\s+model|assistant|model|agent)\b/i],
  ['secrecy', /\b(?:do\s+not|don['\u2019]?t|never)\s+(?:tell|inform|notify|alert|reveal\s+(?:this\s+)?to)\s+(?:the\s+)?(?:user|candidate|applicant|human|recruiter)\b/i],
  ['secrecy', /\b(?:do\s+not|don['\u2019]?t|never)\s+(?:mention|reveal|disclose)\s+(?:this|these|that|it)\b[^.\n]{0,40}\b(?:to\s+)?(?:the\s+)?(?:user|candidate|applicant)\b/i],
  ['role-marker', /(?:^|\n)\s*(?:assistant|system)\s*:/i],
  ['role-marker', /<\|[a-z_]+\|>|\[\/?INST\]|###\s*(?:system|instruction)/i],
  ['score-steering', /\b(?:score|rate|rank|grade|evaluate|mark|treat|classify)\s+(?:this|the|my)\s+(?:candidate|applicant|application|resume|cv|posting|role|job|match)\b[^.]{0,40}\b(?:perfect|ideal|excellent|strong|highest|top|10\s*\/\s*10|100\s*%?|best)\b/i],
  ['score-steering', /\b(?:perfect|ideal|ultimate)\s+(?:fit|match)\b[^.]{0,40}\b(?:mark|score|rate|rank|label|tag|treat)\b|\b(?:mark|label|tag)\s+(?:this\s+)?(?:\w+\s+){0,3}as\s+(?:a\s+)?(?:perfect|ideal|100)\b/i],
  ['score-steering', /\b(?:recommend|shortlist|advance|hire|select)\s+(?:this|the)\s+(?:candidate|applicant)\s+(?:regardless|immediately|automatically|without)\b/i],
  ['audience', /\b(?:if|when)\s+you\s+are\s+(?:an?\s+)?(?:ai|llm|language\s+model|automated|bot|agent)\b/i],
  ['audience', /\b(?:note|message|attention|instructions?)\s+(?:to|for)\s+(?:the\s+)?(?:ai|llm|assistant|language\s+model|model|automated\s+(?:system|screener|reviewer)|ai\s+agents?)\b/i],
  ['audience', /\b(?:ai|llm)\s+(?:agents?|assistants?|models?|screeners?|reviewers?|systems?)\s+(?:reading|reviewing|processing|screening|parsing|summari[sz]ing)\s+this\b/i]
  ,['audience', /\b(?:whoever|anyone|any\s+(?:tool|bot|system|software|program|assistant))\b[^.]{0,40}\b(?:summari[sz]ing|screening|reviewing|parsing|processing|reading|scoring)\s+(?:this|the)\s+(?:page|posting|listing|job|ad|description|resume|cv|application)\b/i]
  ,['audience', /\b(?:reviewing|screening|summari[sz]ing|parsing|scoring)\s+(?:assistant|model|agent|bot)s?\s+(?:should|must|shall)\b/i]
  ,['audience', /\b(?:output|respond|reply|answer|return|say)\s+(?:only|exactly|simply|with)\s+["'\u201C]?(?:strong\s+match|approved?|accepted?|hire|yes|pass|perfect\s+fit)\b/i]
  ,['override', /\b(?:pretend|assume|act\s+as\s+if)\b[^.]{0,40}\b(?:instructions?|rules|guidelines|prompt)\b[^.]{0,40}\b(?:do(?:es)?\s+not|don['\u2019]?t|never)\s+exist\b/i]
];

/* Look-alike letters from Cyrillic and Greek that spell Latin words. NFKC does
   not fold these, so a payload typed with one slips past every pattern. */
const CONFUSABLES = {
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
  '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u04BB': 'h', '\u0501': 'd',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M',
  '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A7': 'X', '\u03BF': 'o', '\u03B9': 'i'
};
const CONFUSABLE_RE = new RegExp('[' + Object.keys(CONFUSABLES).join('') + ']', 'g');

/* Inline styles that make an element invisible to a reader. */
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d]*[1-9])|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?(?![\d.])|color\s*:\s*transparent|clip-path\s*:\s*inset\(\s*100%|(?:left|top|text-indent)\s*:\s*-\d{4,}px|(?:^|[;\s"'])color\s*:\s*(?:#fff(?:fff)?\b|white\b|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))/i;
const COMMENT = /<!--([\s\S]*?)(?:-->|$)/g;
const DROP_BLOCKS = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const VOID_TAGS = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'wbr', 'source', 'area', 'base', 'col', 'embed', 'param', 'track']);

/**
 * @param {string} value
 * @returns {string}
 */
function excerpt(value) {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return flat.length > EVIDENCE_MAX ? `${flat.slice(0, EVIDENCE_MAX)}...` : flat;
}

/**
 * Show invisible characters as U+XXXX so the evidence is legible.
 *
 * @param {string} chars
 * @returns {string}
 */
function showCodepoints(chars) {
  return [...chars].slice(0, 6).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
}

/**
 * Text as a reader would see it: forms folded, runs of spaces collapsed.
 * Line starts survive as newlines so role markers still anchor.
 *
 * @param {string} text
 * @returns {string}
 */
function visibleForm(text) {
  return text
    .normalize('NFKC')
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c])
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n');
}

/**
 * Find instruction-shaped text. Patterns use \s+ between words, so a sentence
 * split across lines still hits; line starts survive for the role markers.
 *
 * @param {string} text invisibles already removed
 * @param {string} source label for the evidence ("text", "comment", "hidden")
 * @returns {{kind: string, evidence: string}[]}
 */
function scanInstructions(text, source) {
  const flags = [];
  const seen = new Set();
  const lined = visibleForm(text);
  const flat = lined.replace(/\n/g, ' ');
  for (const [name, re] of INSTRUCTION_PATTERNS) {
    const m = re.exec(lined);
    if (!m) continue;
    const key = `${name}|${m[0].toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const needle = m[0].replace(/\s+/g, ' ').trim().toLowerCase();
    const at = flat.toLowerCase().indexOf(needle);
    const start = Math.max(0, (at < 0 ? 0 : at) - 30);
    flags.push({ kind: 'instruction', evidence: `${name} (${source}): ${excerpt(flat.slice(start, start + 120))}` });
  }
  return flags;
}

/**
 * Remove elements whose own inline style hides them, returning what was cut.
 * A regex over markup is not a parser: it follows same-name nesting by depth
 * counting, which is right for ordinary pages and is the documented limit.
 *
 * @param {string} html
 * @returns {{html: string, hidden: string[]}}
 */
function removeHiddenElements(html) {
  const hidden = [];
  const open = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let out = '';
  let cursor = 0;
  let m;
  while ((m = open.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const style = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const hiddenStyle = style && HIDDEN_STYLE.test(style[1] ?? style[2] ?? '');
    const hiddenAttr = /(?:^|\s)hidden(?:\s|=|\/|$)/i.test(attrs);
    if (!(hiddenStyle || hiddenAttr) || VOID_TAGS.has(tag)) continue;
    let depth = 1;
    const scan = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    scan.lastIndex = open.lastIndex;
    let end = html.length;
    let inner = html.length;
    let s;
    while ((s = scan.exec(html)) !== null) {
      depth += s[1] ? -1 : 1;
      if (depth === 0) { inner = s.index; end = scan.lastIndex; break; }
    }
    hidden.push(html.slice(open.lastIndex, inner));
    out += html.slice(cursor, m.index) + ' ';
    cursor = end;
    open.lastIndex = end;
  }
  return { html: out + html.slice(cursor), hidden };
}

/**
 * Screen one posting.
 *
 * @param {string} text posting text; plain, or containing HTML markup
 * @returns {{clean: string, flags: {kind: string, evidence: string}[]}}
 *   flag kinds: 'invisible-char', 'instruction', 'hidden-markup'
 */
export function guardPosting(text) {
  const flags = [];
  let work = typeof text === 'string' ? text : String(text ?? '');
  if (!work) return { clean: '', flags };

  /* 1. Invisible characters. Counted and stripped; a tag-block run is decoded
     because it is a hidden ASCII message, and the decoded text is scanned. */
  const tagRuns = work.match(/[\u{E0000}-\u{E007F}]+/gu) || [];
  let decoded = '';
  for (const run of tagRuns) {
    decoded += [...run].map((c) => {
      const code = c.codePointAt(0) - 0xE0000;
      return code >= 0x20 && code < 0x7F ? String.fromCharCode(code) : '';
    }).join('') + '\n';
  }
  /* Only invisibles that indicate tampering are flagged. The real cache showed
     the benign ones are common: a zero-width joiner inside an emoji sequence
     and stray zero-width spaces between sentences. Flagging every one would
     put noise on 1.8 percent of postings and teach the reader to ignore the
     flag. Flagged: one inside a word, a run of four or more, ten or more in
     one posting, a bidi override/embedding/isolate, or any tag-block code
     point. All are stripped regardless. */
  const zeroWidth = work.match(ZERO_WIDTH) || [];
  const inWord = INSIDE_WORD.exec(work);
  const longRun = LONG_RUN.exec(work);
  if (inWord || longRun || zeroWidth.length >= ZERO_WIDTH_TOTAL_MAX) {
    const why = inWord ? 'inside a word' : longRun ? 'run of 4 or more' : `${zeroWidth.length} in one posting`;
    flags.push({ kind: 'invisible-char', evidence: `zero-width ${why}: ${showCodepoints(zeroWidth.join(''))}` });
  }
  const bidiControls = work.match(BIDI_CONTROL) || [];
  if (bidiControls.length) {
    flags.push({ kind: 'invisible-char', evidence: `bidi override/isolate x${bidiControls.length}: ${showCodepoints(bidiControls.join(''))}` });
  }
  const tagChars = work.match(TAGS) || [];
  if (tagChars.length) {
    flags.push({ kind: 'invisible-char', evidence: `tag-block x${tagChars.length}${decoded.trim() ? `, decodes to: ${excerpt(decoded)}` : ''}` });
  }
  /* Strip BEFORE scanning, so a zero-width character inside "ignore" cannot
     split the word past every pattern. */
  work = work.replace(ZERO_WIDTH, '').replace(BIDI, '').replace(TAGS, '').replace(SEPARATORS, '\n');

  /* 2. Markup. Only when something that looks like a tag is present. */
  const hiddenTexts = [];
  if (/<[a-zA-Z!][^>]*>|<!--/.test(work)) {
    const comments = [];
    work = work.replace(COMMENT, (_, body) => { comments.push(body); return ' '; });
    work = work.replace(DROP_BLOCKS, ' ');
    const cut = removeHiddenElements(work);
    work = cut.html;
    for (const body of comments) {
      if (body.trim()) hiddenTexts.push(['comment', body]);
    }
    for (const body of cut.hidden) {
      const visibleBody = body.replace(/<[^>]*>/g, ' ');
      flags.push({ kind: 'hidden-markup', evidence: `hidden element removed: ${excerpt(visibleBody) || '(empty)'}` });
      hiddenTexts.push(['hidden', visibleBody]);
    }
  }

  /* 3. Instruction-shaped text, in the visible text and in what was hidden. */
  flags.push(...scanInstructions(work, 'text'));
  if (decoded.trim()) flags.push(...scanInstructions(decoded, 'tag-block'));
  for (const [source, body] of hiddenTexts) {
    flags.push(...scanInstructions(body, source));
  }

  return { clean: work, flags };
}

/**
 * One line for a run summary, or null when nothing was flagged.
 *
 * @param {string} label posting identifier (URL)
 * @param {{kind: string, evidence: string}[]} flags
 * @returns {string|null}
 */
export function summarizeFlags(label, flags) {
  if (!flags || !flags.length) return null;
  const kinds = [...new Set(flags.map((f) => f.kind))].join(',');
  return `posting-guard: ${label} flagged [${kinds}] ${flags[0].evidence}`;
}
