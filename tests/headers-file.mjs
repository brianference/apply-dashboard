/**
 * Cloudflare Pages `_headers`, applied by the local server too.
 *
 * Without this the local server sent no Content-Security-Policy, so a check
 * that a `blob:` image is REFUSED passed against production and failed locally.
 * The constraint was real in one place and absent in the other, which makes the
 * local run certify something production does not do.
 *
 * Deliberately written with string operations rather than regular expressions:
 * this file is edited through shells that eat backslashes, and a mangled
 * pattern here matches nothing while still looking correct.
 *
 * Format, as Pages defines it: a line starting at column zero is a path
 * pattern, and the indented `Name: value` lines under it are its headers. `*`
 * matches any run of characters. Every matching rule applies, later ones
 * winning, which is how the file is written.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Does a url match a Pages path pattern.
 *
 * @param {string} pattern e.g. "/", "/api/*", "/*.png", "/*"
 * @param {string} url
 * @returns {boolean}
 */
export function matchesPattern(pattern, url) {
  const parts = String(pattern).split('*');
  if (parts.length === 1) return url === pattern;

  /* The text before the first star must be a prefix, the text after the last
     star must be a suffix, and each piece between them must appear in order. */
  if (!url.startsWith(parts[0])) return false;
  const last = parts[parts.length - 1];
  if (last && !url.endsWith(last)) return false;
  if (url.length < parts[0].length + last.length) return false;

  let at = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const piece = parts[i];
    if (!piece) continue;
    const found = url.indexOf(piece, at);
    if (found === -1) return false;
    at = found + piece.length;
  }
  return true;
}

/**
 * Parse a `_headers` file into rules.
 *
 * @param {string} text
 * @returns {Array<{ pattern: string, headers: Record<string,string> }>}
 */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace('\r', '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indented = line[0] === ' ' || line[0] === '\t';
    if (!indented) {
      current = { pattern: trimmed, headers: {} };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const at = trimmed.indexOf(':');
    if (at < 0) continue;
    current.headers[trimmed.slice(0, at).trim().toLowerCase()] = trimmed.slice(at + 1).trim();
  }
  return rules;
}

/**
 * Every header Pages would send for one url.
 *
 * @param {Array<{ pattern: string, headers: Record<string,string> }>} rules
 * @param {string} url
 * @returns {Record<string,string>}
 */
export function headersFor(rules, url) {
  const out = {};
  for (const rule of rules) {
    if (matchesPattern(rule.pattern, url)) Object.assign(out, rule.headers);
  }
  return out;
}

/**
 * Load the rules beside a built directory. Missing file means no rules.
 *
 * @param {string} dir
 * @returns {Array<{ pattern: string, headers: Record<string,string> }>}
 */
export function loadHeaderRules(dir) {
  const file = path.join(dir, '_headers');
  if (!fs.existsSync(file)) return [];
  return parseHeadersFile(fs.readFileSync(file, 'utf8'));
}
