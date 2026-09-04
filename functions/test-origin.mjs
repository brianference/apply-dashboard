/**
 * Origin-checked writes, which FEATURES.md recorded as verified by hand with
 * curl and no test file.
 *
 * Two halves, and the second is the one a curl check could never do. Curling a
 * few endpoints proves those endpoints refuse a bad origin; it says nothing
 * about the route added next week. So this also walks every write handler on
 * disk and requires each one to be authorised by a real mechanism.
 *
 * There are two such mechanisms, and the first version of this file knew only
 * one, so it failed four routes that delegate to refuseWrite and one activated
 * by a hashed single-use token from an emailed link -- a link that arrives with
 * no usable Origin, so demanding one would break account activation.
 *
 *   node functions/test-origin.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originAllowed } from './api/_session.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(70)} ${detail || ''}`);
}

/**
 * @param {string|null} origin
 * @returns {Request}
 */
function post(origin) {
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);
  return new Request('https://apply-dashboard.pages.dev/api/profile', { method: 'PUT', headers });
}

const ENV = { SITE_ORIGIN: 'https://apply-dashboard.pages.dev' };

/* --------------------------------------------------------- the check itself -- */

check('the site\'s own origin is allowed',
  originAllowed(post('https://apply-dashboard.pages.dev'), ENV) === true);
check('another site is refused',
  originAllowed(post('https://evil.example'), ENV) === false);
/* A cookie travels on a cross-site POST, so a missing Origin has to be refused
   rather than waved through: it is a non-browser caller or something stripping
   the header, and neither should be trusted with a write. */
check('a POST with NO origin header is refused, not allowed',
  originAllowed(post(null), ENV) === false);
check('an empty origin string is refused',
  originAllowed(post(''), ENV) === false);

/* Near misses, which are the ones a naive comparison lets through. */
check('a subdomain of the real origin is refused',
  originAllowed(post('https://evil.apply-dashboard.pages.dev'), ENV) === false);
check('the same host over http is refused',
  originAllowed(post('http://apply-dashboard.pages.dev'), ENV) === false);
check('the real origin as a prefix of a longer one is refused',
  originAllowed(post('https://apply-dashboard.pages.dev.evil.example'), ENV) === false);
check('a trailing slash does not make it a different origin that slips through',
  originAllowed(post('https://apply-dashboard.pages.dev/'), ENV) === false);
check('case-changed host is refused rather than silently normalised',
  originAllowed(post('https://APPLY-DASHBOARD.pages.dev'), ENV) === false);

/* Fail closed when the app is misconfigured. An unset SITE_ORIGIN must not
   mean "allow everything". */
check('no SITE_ORIGIN configured refuses every write',
  originAllowed(post('https://apply-dashboard.pages.dev'), {}) === false
  && originAllowed(post('https://apply-dashboard.pages.dev'), { SITE_ORIGIN: '' }) === false);

/* ------------------------------------------------- every write route uses it -- */

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const WRITE_METHODS = /export\s+(?:async\s+)?function\s+onRequest(Post|Put|Patch|Delete)\b/g;

/* A write route is authorised one of two ways, and each is checked by the
   MECHANISM in the file rather than by naming the file. An allowlist of
   exempt filenames grows holes; a mechanism check keeps holding for the
   route added next week.

   Cookie-authenticated: calls originAllowed, or delegates to refuseWrite,
   which calls it. The delegation is not assumed -- refuseWrite's own source is
   asserted below.

   Token-authenticated: activated by a secret from an emailed link, which
   arrives with no usable Origin, so demanding one would break the link. It
   must HASH the presented token before looking it up, so the database never
   holds anything usable and a raw comparison can never be the check. */
const shared = readFileSync(join(HERE, 'api', '_auth.js'), 'utf8');
check('refuseWrite is itself origin-checked, so delegating to it really guards a route',
  /export\s+async\s+function\s+refuseWrite[\s\S]*?originAllowed\s*\(/.test(shared));

const files = walk(join(HERE, 'api'));
const writeRoutes = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const methods = [...src.matchAll(WRITE_METHODS)].map((m) => m[1]);
  if (!methods.length) continue;
  const byOrigin = /originAllowed\s*\(/.test(src) || /refuseWrite\s*\(/.test(src);
  const byToken = /sha256Hex\s*\(/.test(src) && /token/i.test(src);
  writeRoutes.push({
    file: relative(HERE, file).split(String.fromCharCode(92)).join('/'),
    methods, byOrigin, byToken
  });
}

check('write routes were actually found, so this is not passing on an empty list',
  writeRoutes.length >= 5, `${writeRoutes.length} routes with a write method`);

const unguarded = writeRoutes.filter((r) => !r.byOrigin && !r.byToken);
check('every route with a write method is authorised by one of the two mechanisms',
  unguarded.length === 0,
  unguarded.map((r) => `${r.file} (${r.methods.join(',')})`).join(' | ') || 'all guarded');

/* Both mechanisms have to be in use, or this check has quietly become a test
   of one of them while the other rots. */
check('both mechanisms are represented, so neither branch is dead',
  writeRoutes.some((r) => r.byOrigin) && writeRoutes.some((r) => r.byToken && !r.byOrigin),
  `${writeRoutes.filter((r) => r.byOrigin).length} origin, ${writeRoutes.filter((r) => r.byToken && !r.byOrigin).length} token-only`);

for (const route of writeRoutes) {
  check(`  ${route.file}`, route.byOrigin || route.byToken,
    route.methods.join(',') + ' via ' + (route.byOrigin ? 'origin' : 'hashed token'));
}

console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe origin check refuses every near miss, fails closed unconfigured, and every write route calls it');
process.exitCode = bad ? 1 : 0;
