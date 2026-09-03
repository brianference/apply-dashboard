/**
 * The whole test suite, in one command.
 *
 *   node tests/run-all.mjs                 everything that needs no secret
 *   node tests/run-all.mjs --site <url>    browser suites against a real site
 *   node tests/run-all.mjs --with-token    also the audits that read D1
 *   node tests/run-all.mjs --only stale    just the suites matching a string
 *   node tests/run-all.mjs --list          say what would run, run nothing
 *
 * Why this exists. Six suites were added in one day and each had to be wired
 * into .github/workflows/daily-jobs.yml by hand. A test that exists and is not
 * wired in is a test nobody runs, which is worse than no test, because the
 * green tick claims coverage it does not have. So this DISCOVERS test files
 * rather than listing them, and a discovered file that is not classified below
 * FAILS the run. Adding a test now forces a decision about how it runs instead
 * of being silently skipped.
 *
 * tests/check-coverage.mjs enforces the other half: every test on disk must be
 * named in FEATURES.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------- kinds --
   node    plain node, no arguments, no network
   suite   node --test, the ingest/test/*.test.mjs files
   site    takes a URL: driven against the local build or --site
   prod    needs Pages Functions routing, so only a real deployment will do
   token   reads D1 and needs CF_D1_TOKEN, so it is opt-in
   account creates and deletes a real account on the live site, opt-in
   helper  not a test: a module or a server the tests use
   manual  a screenshot or evidence script, run by hand                     */
const KIND = {
  'apply/test-counts.mjs': 'site',
  'apply/test-order.mjs': 'node',
  'ingest/test-board-dates.mjs': 'node',
  'ingest/test-date-backfill.mjs': 'node',
  'ingest/test-dedupe-queue.mjs': 'node',
  'ingest/test-domain.mjs': 'node',
  'ingest/test-employer-block.mjs': 'node',
  'ingest/test-fit.mjs': 'node',
  'ingest/test-index-freshness.mjs': 'node',
  'ingest/test-location.mjs': 'node',
  'ingest/test-off-focus.mjs': 'node',
  'ingest/test-pay-rank.mjs': 'node',
  'ingest/test-pay-tier.mjs': 'node',
  'ingest/test-refresh-audit.mjs': 'node',
  'ingest/test-resolve-by-board.mjs': 'node',
  'ingest/test-salary-ashby.mjs': 'node',
  'ingest/test-salary-audit.mjs': 'node',
  'ingest/test-stale.mjs': 'node',
  'ingest/test-strip.mjs': 'node',
  'ingest/test-sync.mjs': 'node',
  'ingest/test/classify.test.mjs': 'suite',
  'ingest/test/match.test.mjs': 'suite',
  'ingest/test/sources.test.mjs': 'suite',
  'ingest/test/sql.test.mjs': 'suite',
  'tests/check-coverage.mjs': 'node',
  'tests/clear-filters.mjs': 'site',
  'tests/column-menu.mjs': 'site',
  'tests/column-split.mjs': 'site',
  'tests/header-panel.mjs': 'site',
  'tests/leadership-filter.mjs': 'site',
  'tests/posted-filter.mjs': 'site',
  'tests/quick-filter.mjs': 'site',
  'tests/stale-filter.mjs': 'site',
  /* Drives /portfolio/<handle>/, a pretty path served by a Pages Function.
     tests/serve-local.mjs serves static files and proxies /api/*, so that
     route 404s locally and the heading never appears. Read-only against the
     deployment; it creates nothing. */
  'tests/portfolio-addresses.mjs': 'prod',
  'tests/promo-strip.mjs': 'site-flag',
  'tests/tour.mjs': 'site-flag',
  'tests/tour-overflow.mjs': 'site-flag',
  'tests/browser-signup.mjs': 'account',
  'tests/third-party-signup.mjs': 'account',
  'tests/tour-shots.mjs': 'manual',
  'tests/run-all.mjs': 'helper',
  'tests/serve-local.mjs': 'helper',
  'tests/_helpers.mjs': 'helper'
};

/* Extra commands that are not files on the test list but are part of proving
   the pipeline is sound. resume-match's self-check needs the gitignored resume,
   so it is skipped rather than failed when that file is absent. */
const EXTRA = [
  { name: 'ingest/resume-match.mjs --self-check', kind: 'node',
    argv: ['ingest/resume-match.mjs', '--self-check'],
    skipUnless: () => fs.existsSync(path.join(ROOT, 'apply', 'resume-text.local.txt')),
    skipWhy: 'apply/resume-text.local.txt is gitignored and absent here' },
  { name: 'ingest/salary-audit.mjs', kind: 'token', argv: ['ingest/salary-audit.mjs'] },
  { name: 'ingest/refresh-audit.mjs', kind: 'token', argv: ['ingest/refresh-audit.mjs'] }
];

/* ------------------------------------------------------------ arguments -- */
const argv = process.argv.slice(2);
const flag = (name) => argv.indexOf(name) !== -1;
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const only = value('--only', '');
const siteArg = value('--site', '');
const withToken = flag('--with-token');
const withAccount = flag('--with-account');
const listOnly = flag('--list');
const noBuild = flag('--no-build');
const prodSite = value('--prod', 'https://apply-dashboard.pages.dev');
const skipProd = flag('--no-prod');

/* -------------------------------------------------------------- discover -- */
const found = [];
for (const dir of ['ingest', 'apply', 'tests', path.join('ingest', 'test')]) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    if (!name.endsWith('.mjs')) continue;
    if (name.indexOf('.local.') !== -1) continue;
    const rel = path.join(dir, name).split(path.sep).join('/');
    const isTest = /(^|\/)test-|\.test\.mjs$|^tests\//.test(rel);
    if (!isTest) continue;
    found.push(rel);
  }
}
found.sort();

const unclassified = found.filter((f) => !KIND[f]);
if (unclassified.length) {
  console.error('FAIL  test files on disk that tests/run-all.mjs does not classify:');
  for (const f of unclassified) console.error('        ' + f);
  console.error('\n      Add each to KIND in tests/run-all.mjs. A test nobody runs is worse');
  console.error('      than no test: the green tick claims coverage it does not have.');
  process.exit(1);
}

const planned = [];
for (const f of found) {
  const kind = KIND[f];
  if (kind === 'helper' || kind === 'manual') continue;
  planned.push({ name: f, kind, argv: [f] });
}
for (const e of EXTRA) planned.push(e);

const selected = planned.filter((t) => {
  if (only && t.name.indexOf(only) === -1) return false;
  if (t.kind === 'token' && !withToken) return false;
  if (t.kind === 'account' && !withAccount) return false;
  if (t.kind === 'prod' && skipProd) return false;
  return true;
});

if (listOnly) {
  for (const t of selected) console.log(`${t.kind.padEnd(10)} ${t.name}`);
  console.log(`\n${selected.length} of ${planned.length} would run`);
  console.log(`skipped: ${planned.length - selected.length} (token and account suites are opt-in)`);
  process.exit(0);
}

if (withToken && !process.env.CF_D1_TOKEN) {
  console.error('FAIL  --with-token was passed but CF_D1_TOKEN is not set.');
  process.exit(1);
}

/* --------------------------------------------------------------- runner -- */
/**
 * @param {string[]} args node arguments
 * @param {Record<string,string>} [env]
 * @returns {Promise<{code:number, out:string, ms:number}>}
 */
function run(args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: Object.assign({}, process.env, env || {})
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, out, ms: Date.now() - started }));
  });
}

const needsSite = selected.some((t) => t.kind === 'site' || t.kind === 'site-flag');
let site = siteArg;
let server = null;

if (needsSite && !site) {
  if (!noBuild) {
    process.stdout.write('building .deploy ... ');
    const build = await new Promise((resolve) => {
      const c = spawn('bash', ['build-deploy.sh'], { cwd: ROOT });
      let o = '';
      c.stdout.on('data', (d) => { o += d; });
      c.stderr.on('data', (d) => { o += d; });
      c.on('close', (code) => resolve({ code, o }));
    });
    if (build.code !== 0) {
      console.error('FAIL\n' + build.o);
      process.exit(1);
    }
    console.log('ok');
  }
  process.stdout.write('starting the local server ... ');
  site = await new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['tests/serve-local.mjs'], { cwd: ROOT });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server did not print a URL')), 15000);
    server.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    server.stderr.on('data', (d) => { buf += d; });
  }).catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
  console.log(site);
}

console.log('');
const results = [];
for (const t of selected) {
  if (t.skipUnless && !t.skipUnless()) {
    console.log(`skip  ${t.name.padEnd(42)} ${t.skipWhy}`);
    results.push({ name: t.name, skipped: true });
    continue;
  }
  let args;
  if (t.kind === 'suite') args = ['--test', t.name];
  else if (t.kind === 'site') args = [t.argv[0], site];
  else if (t.kind === 'site-flag') args = [t.argv[0], '--site', site];
  else if (t.kind === 'prod') args = [t.argv[0], '--site', prodSite];
  else args = t.argv.slice();

  const r = await run(args);
  const ok = r.code === 0;
  results.push({ name: t.name, ok, out: r.out, ms: r.ms });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.name.padEnd(42)} ${String(r.ms + 'ms').padStart(7)}`);
}

if (server) server.kill();

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.skipped);
const passed = results.filter((r) => r.ok === true);

if (failed.length) {
  console.log('\n' + '-'.repeat(64));
  for (const f of failed) {
    console.log(`\n--- ${f.name} ---`);
    console.log(f.out.trim().split('\n').slice(-25).join('\n'));
  }
}

console.log('\n' + '-'.repeat(64));
console.log(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`
  + (site ? `   (browser suites against ${site})` : ''));
if (!withToken) console.log('note: the D1 audits were skipped. Add --with-token with CF_D1_TOKEN set.');
if (!withAccount) console.log('note: the signup suites were skipped. Add --with-account, they hit production.');
if (!skipProd) console.log('note: the portfolio suite ran read-only against ' + prodSite
  + ' -- it needs Pages Functions routing. --no-prod skips it.');
console.log(failed.length ? 'THE SUITE FAILED' : 'the whole suite passes');
process.exitCode = failed.length ? 1 : 0;
