/**
 * One-off screenshots of each tour step. Not part of the gate.
 */
import { createRequire } from 'node:module';
/* Brian's machine keeps Playwright in RedAnvil; a CI runner installs its own.
   Try the local copy, fall back to a normal resolution, so the same file runs
   in both places -- and in a git WORKTREE, which has no node_modules of its
   own. A direct `import { chromium } from 'playwright'` fails there, which is
   how a delegated run reported four failures that were not its fault. */
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'tests', 'tour-shots');
fs.mkdirSync(OUT, { recursive: true });

/**
 * @param {string} file
 * @returns {string}
 */
function mime(file) {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

/**
 * @param {string} urlPath
 * @returns {string|null}
 */
function fileFor(urlPath) {
  let rel = decodeURIComponent((urlPath || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const trimmed = rel.replace(/^\/+/, '');
  for (const full of [path.join(WEB, trimmed), path.join(ROOT, trimmed)]) {
    const resolved = path.resolve(full);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    const asIndex = path.join(resolved, 'index.html');
    if (fs.existsSync(asIndex)) return asIndex;
  }
  return null;
}

const jobs = [];
for (let i = 0; i < 24; i++) {
  jobs.push({
    dedupe_key: `tour-job-${i}`,
    company: i === 0 ? 'PeopleGrove' : `Company ${i}`,
    title: i === 0 ? 'Senior Product Manager' : `Product Manager ${i}`,
    url: `https://jobs.lever.co/example/${i}`,
    match_pct: 80 - i,
    source: 'lever',
    status: 'queued',
    lane: 'ft',
    submitted_at: null,
    work_type: 'Remote · United States',
    salary_min: 180000,
    salary_max: 220000,
    blocked_reason: null
  });
}

const server = http.createServer((req, res) => {
  const file = fileFor(req.url);
  if (!file) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': mime(file) });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const site = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

for (const [width, height] of [[1280, 900], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      authenticated: true,
      email: 'tour.user@example.invalid',
      name: 'Tour User',
      avatar: null,
      since: '2026-01-01T00:00:00.000Z',
      tour_seen_at: null
    })
  }));
  await page.route('**/api/jobs**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jobs })
  }));
  await page.route('**/api/tour/seen', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true })
  }));
  await page.goto(`${site}/`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 5; i++) {
    await page.waitForSelector(`#tour-popover[data-ready="1"][data-step="${i}"]`, { timeout: 15000 });
    await page.screenshot({ path: path.join(OUT, `${width}-step${i + 1}.png`) });
    if (i < 4) await page.getByRole('button', { name: 'Next' }).click();
  }
  await ctx.close();
}

await browser.close();
server.close();
console.log('wrote', OUT);
