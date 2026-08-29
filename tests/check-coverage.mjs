/**
 * Keep FEATURES.md honest.
 *
 * A coverage table is worth nothing if it can name a test that does not exist,
 * because then the gaps it claims to expose are themselves unverified. This
 * reads every `path/to/test.mjs` mentioned in the Automated column and fails
 * when one is not on disk. It also reports every test file in the repo that the
 * table never mentions, which is the other direction of the same drift: a test
 * nobody knows about is not coverage anyone can rely on.
 *
 *   node tests/check-coverage.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* The doc path is an argument so this checker's own failure modes can be
   produced on a fixture. A checker that has only ever been run against a
   passing input is a claim, not a check. */
const DOC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'FEATURES.md');

/** Any backticked path that ends in .mjs is a claim that the file exists. */
const NAMED_TEST = /`([A-Za-z0-9_\-/.]+\.mjs)`/g;

/** Directories that hold tests this table is expected to account for. */
const TEST_DIRS = ['tests', 'apply', 'ingest'];

/** Files that are helpers or ad-hoc probes, not tests to be listed. */
const NOT_A_TEST = /(^_|\.local\.mjs$|check-coverage\.mjs$|_helpers\.mjs$)/;

const problems = [];

if (!fs.existsSync(DOC)) {
  console.error('FAIL  FEATURES.md is missing');
  process.exit(1);
}

const doc = fs.readFileSync(DOC, 'utf8');

/* 1. Everything the table names must exist. */
const named = new Set();
for (const match of doc.matchAll(NAMED_TEST)) named.add(match[1]);
for (const rel of [...named].sort()) {
  const exists = fs.existsSync(path.join(ROOT, rel));
  console.log(`${exists ? 'PASS' : 'FAIL'}  named in FEATURES.md and present: ${rel}`);
  if (!exists) problems.push(`FEATURES.md names ${rel}, which does not exist`);
}

/* 2. Everything that exists should be accounted for. */
const onDisk = [];
for (const dir of TEST_DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const file of fs.readdirSync(full)) {
    if (!file.startsWith('test-') && !full.endsWith('tests')) continue;
    if (!file.endsWith('.mjs') || NOT_A_TEST.test(file)) continue;
    onDisk.push(`${dir}/${file}`);
  }
}
const unlisted = onDisk.filter((rel) => !named.has(rel));
for (const rel of unlisted) {
  console.log(`FAIL  a test exists that FEATURES.md never mentions: ${rel}`);
  problems.push(`${rel} is not in FEATURES.md`);
}

/* 3. The gap list has to be real too. A table with no gaps in a product this
      size means the gaps stopped being written down, not that they closed. */
const gapCount = (doc.match(/\*\*Gap\.\*\*/g) || []).length;
console.log(`INFO  ${named.size} tests named, ${onDisk.length} on disk, ${gapCount} gaps recorded`);

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\nFEATURES.md matches the tests on disk');
