/**
 * Employers whose postings never reach the queue.
 *
 * The list is ingest/blocked-employers.json. `match` is a substring of the
 * NORMALISED company name: lowercase, punctuation turned into spaces,
 * whitespace collapsed. Spaces are kept on purpose. "Coinbase Global, Inc."
 * normalises to "coinbase global inc" and contains "coinbase". "Bitcoin Base"
 * normalises to "bitcoin base" and does not: stripping spaces would glue it
 * into "bitcoinbase", which contains "coinbase" and would block the wrong
 * employer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIST_PATH = path.join(HERE, 'blocked-employers.json');

/**
 * @typedef {{name: string, match: string, since?: string, reason: string}} BlockedEmployer
 */

/** @type {BlockedEmployer[]} */
export const BLOCKED_EMPLOYERS = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
if (!Array.isArray(BLOCKED_EMPLOYERS)) {
  throw new Error('ingest/blocked-employers.json must be an array');
}
for (const entry of BLOCKED_EMPLOYERS) {
  if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) {
    throw new Error('blocked employer is missing name');
  }
  if (typeof entry.match !== 'string' || !entry.match.trim()) {
    throw new Error(`blocked employer ${entry.name} is missing match`);
  }
  if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
    throw new Error(`blocked employer ${entry.name} is missing reason`);
  }
}

/**
 * Lowercase the name and turn punctuation into spaces so "Coinbase Global,
 * Inc." still contains the match string. Spaces stay: collapsing them would
 * make "Bitcoin Base" match "coinbase".
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeEmployerName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which blocked-employer entry, if any, matches this company name.
 *
 * @param {unknown} company
 * @param {BlockedEmployer[]} [list]
 * @returns {BlockedEmployer|null}
 */
export function findBlockedEmployer(company, list = BLOCKED_EMPLOYERS) {
  const normalised = normalizeEmployerName(company);
  if (!normalised) return null;
  for (const entry of list) {
    const needle = normalizeEmployerName(entry && entry.match);
    if (!needle) continue;
    if (normalised.includes(needle)) return entry;
  }
  return null;
}

/**
 * Gate reason for a blocked employer. Shape:
 * `employer: Coinbase is blocked - employer application limit reached`
 *
 * @param {BlockedEmployer} entry
 * @returns {string}
 */
export function employerBlockReason(entry) {
  return `employer: ${entry.name} is blocked - ${entry.reason}`;
}
