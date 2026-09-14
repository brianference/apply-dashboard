/**
 * Take a restore point: the queue, the researched contacts, and what is
 * currently deployed.
 *
 * WHERE IT WRITES, AND WHY NOT HERE. The archive lands OUTSIDE this repository,
 * under ~/backups/apply-dashboard by default. This repo is public, and a
 * 1.2MB queue dump committed daily would both bloat it and publish the exact
 * shape of his search on a schedule. A snapshot is a backup, not a deliverable.
 *
 * WHAT MAKES IT A RESTORE POINT RATHER THAN A FILE. Three things travel
 * together, because any one of them alone cannot rebuild the state:
 *   - jobs.json      every row the API serves, which is the queue itself
 *   - contacts.json  the researched people, which no ingest run can recreate
 *   - manifest.json  row counts, a sha256 per file, the live build stamp and
 *                    the git commit, so a restore can be checked rather than
 *                    hoped at
 *
 * The manifest is the part that matters. A dump with no checksum and no commit
 * is indistinguishable from a truncated dump, and the failure mode of a backup
 * is discovering that at the moment you need it.
 *
 *   node ingest/snapshot.mjs                  write a snapshot
 *   node ingest/snapshot.mjs --verify <dir>   re-check an existing one
 *   node ingest/snapshot.mjs --out <dir>      somewhere other than the default
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SITE = process.env.SNAPSHOT_SITE || 'https://apply-dashboard.pages.dev';
const DEFAULT_ROOT = path.join(os.homedir(), 'backups', 'apply-dashboard');

/** Files that travel together. The API path, and the name in the archive. */
const PARTS = [
  { name: 'jobs.json', url: '/api/jobs', rows: (j) => (j.jobs || []).length },
  { name: 'contacts.json', url: '/outreach/data/contacts.json', rows: (j) => Object.keys(j.companies || {}).length }
];

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The commit this snapshot was taken at, or null outside a checkout.
 *
 * @returns {string|null}
 */
function headCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * The build stamp the production page is serving right now.
 *
 * Recorded because a restore has to know which build the data belonged to. The
 * alias is edge-cached for about a minute after a deploy, so this is the served
 * stamp rather than the newest one.
 *
 * @returns {Promise<string|null>}
 */
async function liveStamp() {
  try {
    const res = await fetch(`${SITE}/?snapshot=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
    const html = await res.text();
    const found = html.match(/20\d\d-\d\d-\d\d \d\d:\d\dZ/);
    return found ? found[0] : null;
  } catch {
    return null;
  }
}

/**
 * Re-check a snapshot against its own manifest.
 *
 * @param {string} dir
 * @returns {boolean} true when every file is present and its hash matches
 */
export function verifySnapshot(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`FAIL no manifest.json in ${dir}`);
    return false;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let ok = true;
  for (const part of manifest.parts || []) {
    const file = path.join(dir, part.name);
    if (!fs.existsSync(file)) {
      console.error(`FAIL ${part.name} is missing`);
      ok = false;
      continue;
    }
    const got = sha256(fs.readFileSync(file, 'utf8'));
    const same = got === part.sha256;
    if (!same) ok = false;
    console.log(`${same ? 'ok  ' : 'FAIL'} ${part.name.padEnd(16)} ${part.rows} rows  ${got.slice(0, 12)}`);
  }
  console.log(ok
    ? `\nthe snapshot is intact: ${manifest.takenAt}, build ${manifest.buildStamp}, commit ${String(manifest.commit).slice(0, 8)}`
    : '\nthe snapshot is DAMAGED and must not be restored from');
  return ok;
}

/**
 * Fetch every part and write the archive.
 *
 * @param {string} root
 * @returns {Promise<string>} the directory written
 */
async function takeSnapshot(root) {
  const takenAt = new Date().toISOString();
  const dir = path.join(root, takenAt.slice(0, 19).replace(/[:T]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });

  const parts = [];
  for (const part of PARTS) {
    const res = await fetch(`${SITE}${part.url}`, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`${part.url} answered HTTP ${res.status}`);
    const text = await res.text();
    /* Parsed before it is trusted: a truncated body is still a 200. */
    const parsed = JSON.parse(text);
    const rows = part.rows(parsed);
    if (!rows) throw new Error(`${part.url} returned 0 rows, refusing to write an empty snapshot`);
    fs.writeFileSync(path.join(dir, part.name), text, 'utf8');
    parts.push({ name: part.name, rows, bytes: text.length, sha256: sha256(text) });
    console.log(`wrote ${part.name.padEnd(16)} ${rows} rows, ${text.length} bytes`);
  }

  const manifest = {
    takenAt,
    site: SITE,
    buildStamp: await liveStamp(),
    commit: headCommit(),
    parts
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`\nsnapshot at ${dir}`);
  console.log(`build ${manifest.buildStamp}, commit ${String(manifest.commit).slice(0, 8)}`);
  return dir;
}

const args = process.argv.slice(2);
const verifyAt = args.includes('--verify') ? args[args.indexOf('--verify') + 1] : null;
const outRoot = args.includes('--out') ? args[args.indexOf('--out') + 1] : DEFAULT_ROOT;

if (verifyAt) {
  process.exitCode = verifySnapshot(verifyAt) ? 0 : 1;
} else {
  const dir = await takeSnapshot(outRoot);
  /* A snapshot nobody has verified is a hope. Check it immediately, against the
     manifest just written, so a bad write is caught now and not in a crisis. */
  console.log('\nre-reading it from disk:');
  process.exitCode = verifySnapshot(dir) ? 0 : 1;
}
