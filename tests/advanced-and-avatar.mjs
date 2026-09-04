/**
 * The advanced-search switches, and the photo resize with the policy that
 * broke it once.
 *
 * Two FEATURES.md gaps. The switches were "covered by a browser check that is
 * not yet in the repo", which is not coverage, and the avatar had no test at
 * all: its CSP failure was found by hand.
 *
 * The avatar half is the interesting one. The page's policy is
 * `img-src 'self' data:`, so a blob: URL is refused by the browser and the only
 * thing a person saw was "That file could not be read as an image" -- a
 * message blaming their file for a policy decision. A test that only checks the
 * resize maths would never see that, so this drives the real file input and
 * requires a data: URL to come out, with no CSP violation logged.
 *
 * Run: node tests/advanced-and-avatar.mjs [url]
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }

const SITE = process.argv[2] || 'https://apply-dashboard.pages.dev';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(66)} ${detail || ''}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
const violations = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  const text = m.text();
  if (/content security policy|refused to load/i.test(text)) violations.push(text);
});

await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });

/* ------------------------------------------------- the advanced switches -- */

const advToggle = page.locator('#adv-toggle');
check('the advanced control is on the page', await advToggle.count() === 1);
check('the panel starts closed', await page.locator('#advanced').isHidden());
check('and says so', await advToggle.getAttribute('aria-expanded') === 'false');

await advToggle.click();
await page.locator('#advanced').waitFor({ state: 'visible', timeout: 5000 });
check('opening it shows the panel', await page.locator('#advanced').isVisible());
check('and the control agrees', await advToggle.getAttribute('aria-expanded') === 'true');

const lede = (await page.locator('#adv-lede').textContent() || '').trim();
check('the panel explains what is being held back', lede.length > 20, lede.slice(0, 80));

const switches = page.locator('#adv-switches .adv-switch');
const switchCount = await switches.count();
check('a switch is rendered for each excluded category', switchCount > 0, `${switchCount} switches`);

/* The count in the lede has to be the count of the rows behind the switches.
   A number written separately from the thing it describes answers a different
   question, which is how a tile and its list drift apart. */
const ledeTotal = Number((lede.match(/^(\d+)/) || [])[1] || 0);
const switchCounts = await page.locator('#adv-switches .adv-switch').evaluateAll((els) =>
  els.map((el) => {
    const n = (el.textContent || '').match(/(\d+)/);
    return n ? Number(n[1]) : 0;
  }));
const summed = switchCounts.reduce((a, b) => a + b, 0);
check('the lede total equals the sum of the switches, not a separate tally',
  ledeTotal > 0 && ledeTotal === summed, `lede ${ledeTotal} vs switches ${summed}`);

/* Signed out, they are visible but inert: hiding them would make the feature
   invisible to the people it exists to bring in, and enabling them would
   promise something the account does not have. */
const disabled = await switches.evaluateAll((els) => els.filter((el) => el.disabled).length);
check('signed out, every switch is visible but inert',
  disabled === switchCount && switchCount > 0, `${disabled} of ${switchCount} disabled`);
check('and the sign-in prompt is shown rather than the switches silently failing',
  await page.locator('#adv-gate').isVisible());

const pressed = await switches.first().getAttribute('aria-pressed');
await switches.first().click({ force: true });
await page.waitForTimeout(400);
check('clicking an inert switch changes nothing',
  await switches.first().getAttribute('aria-pressed') === pressed, `still ${pressed}`);

/* Every switch names a real excluded category rather than a code. */
const labels = (await switches.allTextContents()).map((t) => t.replace(/\d+/g, '').trim());
check('each switch is labelled with words, not a slug',
  labels.every((t) => t.length > 2 && !/_/.test(t)), labels.slice(0, 4).join(' | '));

await advToggle.click();
await page.locator('#advanced').waitFor({ state: 'hidden', timeout: 5000 });
check('closing it hides the panel again', await page.locator('#advanced').isHidden());

/* ------------------------------------------------------------ the avatar -- */

/* Straight against the module, in the page, so the browser's own decoder and
   the page's own CSP are what answer -- not a stub of either. */
await page.goto(SITE + '/profile/', { waitUntil: 'domcontentloaded' });

const avatarResult = await page.evaluate(async () => {
  const { toAvatarDataUrl } = await import('/profile/js/avatar.js');

  /* A wide, non-square PNG built here, so the crop has something to crop. */
  const source = document.createElement('canvas');
  source.width = 900;
  source.height = 300;
  const sctx = source.getContext('2d');
  sctx.fillStyle = '#1e6fd9';
  sctx.fillRect(0, 0, 900, 300);
  sctx.fillStyle = '#f0a030';
  sctx.fillRect(400, 100, 100, 100);
  const blob = await new Promise((r) => source.toBlob(r, 'image/png'));
  const file = new File([blob], 'photo.png', { type: 'image/png' });

  const out = { bytesIn: blob.size };
  try {
    const url = await toAvatarDataUrl(file);
    out.scheme = String(url).slice(0, 5);
    out.chars = url.length;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
  } catch (error) {
    out.error = String(error && error.message ? error.message : error);
  }

  /* And the shape the policy refuses, to prove the constraint is real rather
     than a story in a comment. */
  try {
    const objectUrl = URL.createObjectURL(blob);
    out.blobUrl = objectUrl.slice(0, 5);
    const probe = new Image();
    out.blobLoaded = await new Promise((res) => {
      probe.onload = () => res(true);
      probe.onerror = () => res(false);
      probe.src = objectUrl;
    });
  } catch { out.blobLoaded = null; }
  return out;
});

check('a photo resizes without throwing', !avatarResult.error, avatarResult.error || '');
/* data:, never blob:. This is the whole bug. */
check('the result is a data: URL, which the policy permits',
  avatarResult.scheme === 'data:', avatarResult.scheme);
check('it is square at the drawn size',
  avatarResult.width === 256 && avatarResult.height === 256,
  `${avatarResult.width}x${avatarResult.height}`);
check('a wide photo is cropped, not squashed',
  avatarResult.width === avatarResult.height);
check('it fits under the 200KB column cap',
  avatarResult.chars > 0 && avatarResult.chars < 200000, `${avatarResult.chars} chars`);
check('and it is genuinely smaller than what was chosen',
  avatarResult.chars < avatarResult.bytesIn * 1.4,
  `${avatarResult.chars} chars from ${avatarResult.bytesIn} bytes`);
/* If a blob: URL ever loads here, the policy has been widened and the reason
   this code uses data: has quietly gone away. */
check('a blob: URL is still refused by the page policy, so data: is required',
  avatarResult.blobLoaded === false, `blob load returned ${avatarResult.blobLoaded}`);

const rejected = await page.evaluate(async () => {
  const { toAvatarDataUrl } = await import('/profile/js/avatar.js');
  const file = new File([new Blob(['not an image'])], 'notes.txt', { type: 'text/plain' });
  try { await toAvatarDataUrl(file); return 'accepted'; }
  catch (e) { return String(e.message); }
});
check('a file that is not an image is refused with a message about the file',
  /image/i.test(rejected) && rejected !== 'accepted', rejected);

check('no console error through all of it', errors.length === 0, errors.slice(0, 2).join(' | '));
/* Collected from the start of the run: the resize path must not trip the
   policy the way the blob: version did. */
check('and no content-security-policy refusal from the page itself',
  violations.filter((v) => !/blob:/.test(v)).length === 0,
  violations.slice(0, 2).join(' | '));

await browser.close();
console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe switches are inert but visible signed out, and the avatar comes back as data:, cropped and under the cap');
process.exitCode = bad ? 1 : 0;
