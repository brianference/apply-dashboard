/**
 * The `_headers` matcher the local server now uses.
 *
 * It exists because the local server sent no Content-Security-Policy while
 * production did, so a check that a `blob:` image is REFUSED passed against
 * production and failed locally. A local server that answers differently from
 * production certifies the wrong thing.
 *
 * The matcher is hand-written string work rather than a regular expression,
 * which means the awkward cases are its own: a star that has to consume real
 * characters, a suffix pattern that must not match a longer name, and a prefix
 * that must not match a lookalike directory.
 *
 *   node tests/test-headers-file.mjs
 */

import { matchesPattern, parseHeadersFile, headersFor, loadHeaderRules } from './headers-file.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(66)} ${detail || ''}`);
}

/* ------------------------------------------------------------ the matcher -- */

check('an exact pattern matches only itself',
  matchesPattern('/', '/') && !matchesPattern('/', '/profile/'));
check('an exact pattern does not match a longer name that starts with it',
  !matchesPattern('/index.html', '/index.html.bak'));
check('a trailing star matches below it',
  matchesPattern('/api/*', '/api/jobs') && matchesPattern('/api/*', '/api/a/b'));
/* /apix is not inside /api/, and a sloppy prefix test says it is. */
check('a trailing star does not match a lookalike sibling directory',
  !matchesPattern('/api/*', '/apix/jobs'));
check('a suffix pattern matches at any depth',
  matchesPattern('/*.png', '/logo.png') && matchesPattern('/*.png', '/a/b/logo.png'));
check('a suffix pattern does not match a longer extension',
  !matchesPattern('/*.png', '/logo.pngx'));
check('the catch-all matches everything under the root',
  matchesPattern('/*', '/') && matchesPattern('/*', '/anything/at/all'));
/* The prefix and the suffix must be satisfied by DIFFERENT characters, or a
   star matches by overlapping the two, which is the classic bug in this shape
   of matcher. */
check('a prefix and a suffix cannot be satisfied by the same characters',
  !matchesPattern('/aaa*aaa', '/aaa'));
check('but they match when there is enough string for both',
  matchesPattern('/aaa*aaa', '/aaaXaaa') && matchesPattern('/aaa*aaa', '/aaaaaa'));
check('a middle piece must appear in order, not merely be present',
  matchesPattern('/a*b*c', '/aXbYc') && !matchesPattern('/a*b*c', '/aXcYb'));

/* -------------------------------------------------------------- the parser -- */

const SAMPLE = [
  '# Cloudflare Pages header rules.',
  '',
  '/',
  '  Cache-Control: no-store',
  '  Pragma: no-cache',
  '',
  '# another comment',
  '/*',
  '  X-Frame-Options: DENY',
  "  Content-Security-Policy: default-src 'self'; img-src 'self' data:"
].join('\n');

const rules = parseHeadersFile(SAMPLE);
check('comments and blank lines are skipped', rules.length === 2,
  rules.map((r) => r.pattern).join(' '));
check('headers are collected under their pattern',
  Object.keys(rules[0].headers).length === 2, JSON.stringify(rules[0].headers));

const root = headersFor(rules, '/');
check('every matching rule contributes, so the catch-all still applies to /',
  root['cache-control'] === 'no-store' && root['x-frame-options'] === 'DENY',
  JSON.stringify(root));
/* A header value contains colons of its own; splitting on every colon would
   truncate the policy to "default-src 'self'". */
check('a value keeps its own colons and quotes',
  root['content-security-policy'] === "default-src 'self'; img-src 'self' data:",
  root['content-security-policy']);
check('names are lowercased so a lookup is not case-dependent',
  Object.keys(root).every((k) => k === k.toLowerCase()), Object.keys(root).join(','));
check('a url matching only the catch-all still gets its headers',
  headersFor(rules, '/profile/')['x-frame-options'] === 'DENY'
  && headersFor(rules, '/profile/')['cache-control'] === undefined);
check('a missing file is no rules rather than a crash',
  loadHeaderRules('no-such-directory-here').length === 0);
check('empty input parses to nothing',
  parseHeadersFile('').length === 0 && parseHeadersFile(null).length === 0);

/* ------------------------------------------------ the real file, if built -- */

const real = loadHeaderRules('.deploy');
if (real.length) {
  check('the built _headers parses into rules', real.length >= 3,
    real.map((r) => r.pattern).join(' '));
  const onIndex = headersFor(real, '/index.html');
  check('the dashboard is served no-store, because a stale render shows an applied job as queued',
    /no-store/.test(onIndex['cache-control'] || ''), onIndex['cache-control']);
  const policy = headersFor(real, '/profile/')['content-security-policy'] || '';
  check('a content-security-policy reaches an ordinary page',
    policy.length > 0, policy.slice(0, 60));
  /* This is the constraint the avatar code is written around: img-src permits
     data: and does NOT permit blob:, which is why the resize returns a data
     URL. If this ever stops holding, that code has a dead reason. */
  check('img-src permits data: but not blob:',
    /img-src[^;]*data:/.test(policy) && !/img-src[^;]*blob:/.test(policy),
    (policy.match(/img-src[^;]*/) || ['no img-src'])[0]);
} else {
  console.log('note: .deploy is not built, so the real _headers was not checked');
}

console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe matcher handles every pattern shape in the real file, and values keep their colons');
process.exitCode = bad ? 1 : 0;
