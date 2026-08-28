/**
 * Push collected postings into D1, enforcing Brian's rules BEFORE the write.
 *
 * The collector (`upsert.mjs --from-sources`) dedupes only within its own
 * batch and applies no eligibility rules at all, so running it straight into
 * the database re-adds postings that are already there and adds roles that
 * were ruled out. Both have happened: a "Senior Engineering Manager" sat in a
 * product-only list, and one job reached the queue twice under two different
 * dedupe keys because the two listings spelled the company differently.
 *
 * Order matters. Filter, then dedupe, then score, then write. A rank is not a
 * filter -- scoring an ineligible posting well and showing it anyway wastes
 * the only scarce resource here, which is Brian's attention.
 *
 * Usage:
 *   node ingest/sync-to-d1.mjs --input ingest/out/jobs.json           # dry run
 *   node ingest/sync-to-d1.mjs --input ingest/out/jobs.json --write   # insert
 *
 * Credentials come from the environment only (CF_D1_TOKEN), never from a file
 * in this repo -- it is public.
 */

import { readFile } from "node:fs/promises";
import { isCli, parseArgs } from "./cli.mjs";
import { assignLane, dedupeKey, dupeSignature, scoreMatch } from "./match.mjs";
import { locationEligible, roleEligible } from "./location-eligible.mjs";

const ACCOUNT = "dd01b432f0329f87bb1cc1a3fad590ee";
const DATABASE = "10e8a6c0-1fa7-4c33-a007-2044876ce6a7";
const READ_API = "https://apply-dashboard.pages.dev/api/jobs";

/**
 * Compare two posting URLs as the same page.
 *
 * Two rows can carry the same posting under different dedupe keys -- an
 * aggregator listing and the company's own listing -- and that produced a real
 * duplicate application to GitLab. The key check alone cannot catch it, so the
 * URL is normalised and checked too. Tracking parameters are dropped; a board's
 * own identifying query (gh_jid, lever ids) is NOT, because two postings can
 * differ only there.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return String(raw || "").trim().toLowerCase(); }
  /* BuiltIn re-lists a job already captured from its own ATS (Lever, iCIMS)
     and tags the re-scrape with its own query params -- lever-source and, on
     iCIMS, hub/ss/mode/iis/iisn. Six queued duplicates on 2026-08-28 all had
     this exact shape: same underlying job, missed because these weren't
     stripped. */
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|ref$|referer|source$|src$|gh_src|lever-origin|lever-source|trackingid|hub$|ss$|mode$|iis$|iisn$)/i.test(k)) {
      u.searchParams.delete(k);
    }
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  let path = u.pathname.replace(/\/+$/, "").toLowerCase();
  /* Lever/Ashby's own apply-page suffix, not part of the job's identity. */
  path = path.replace(/\/apply$/, "");
  /* iCIMS embeds the numeric job id in the path alongside a title slug that
     BuiltIn re-derives with different spacing, punctuation and encoding. The
     id is the job; the slug is decoration that defeats an exact match. */
  if (host.endsWith(".icims.com")) {
    const m = path.match(/^(\/jobs\/\d+)\//);
    if (m) path = m[1];
  }
  const q = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("&");
  return `${host}${path}${q ? `?${q}` : ""}`;
}

/**
 * Escape a value for a single-quoted SQL literal, or render NULL.
 * @param {unknown} v
 * @returns {string}
 */
function sq(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Run one SQL statement against D1 over the REST API.
 * @param {string} token
 * @param {string} sql
 * @returns {Promise<{success: boolean, errors: unknown}>}
 */
async function d1(token, sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql })
    }
  );
  const body = await res.json().catch(() => ({ success: false, errors: [`HTTP ${res.status}`] }));
  return body;
}

/**
 * Decide every candidate against the live database and Brian's rules.
 *
 * Exported so the decision can be tested without a network write.
 *
 * @param {Array<Record<string, unknown>>} candidates
 * @param {Array<Record<string, unknown>>} existing
 * @returns {{fresh: Array<Record<string, unknown>>, rejected: Record<string, number>}}
 */
export function decide(candidates, existing) {
  const seenKeys = new Set(existing.map(r => String(r.dedupe_key || "").toLowerCase()));
  const seenUrls = new Set(existing.map(r => normalizeUrl(r.url)));
  const seenSigs = new Set(existing.map(r => dupeSignature(r.company, r.title)));
  const rejected = { role: 0, location: 0, "duplicate-key": 0, "duplicate-url": 0, "duplicate-signature": 0, "no-url": 0 };
  const fresh = [];
  for (const c of candidates) {
    const title = String(c.title || "");
    const url = String(c.url || "");
    if (!url) { rejected["no-url"] += 1; continue; }
    if (!roleEligible(title).ok) { rejected.role += 1; continue; }
    if (!locationEligible(c.work_type, title).ok) { rejected.location += 1; continue; }
    const key = dedupeKey(c.company, title);
    if (seenKeys.has(key.toLowerCase())) { rejected["duplicate-key"] += 1; continue; }
    const nurl = normalizeUrl(url);
    if (seenUrls.has(nurl)) { rejected["duplicate-url"] += 1; continue; }
    /* Catches the case a key or URL match cannot: the same job re-listed by
       an aggregator under a title that gained a "- CompanyName" suffix, on a
       URL that shares no structure with the original (different host,
       different query shape). */
    const sig = dupeSignature(c.company, title);
    if (seenSigs.has(sig)) { rejected["duplicate-signature"] += 1; continue; }
    /* Guard the batch against itself as well as against D1: two sources
       routinely carry the same posting, and nothing upstream has merged them. */
    seenKeys.add(key.toLowerCase());
    seenUrls.add(nurl);
    seenSigs.add(sig);
    const row = { ...c, dedupe_key: key };
    row.match_pct = scoreMatch(row);
    row.lane = assignLane(row);
    fresh.push(row);
  }
  fresh.sort((a, b) => (b.match_pct || 0) - (a.match_pct || 0));
  return { fresh, rejected };
}

/* Import-safe: the decision logic above is unit-tested, and a test that
   imports this module must not fire a live fetch or a write. */
if (isCli(import.meta.url)) {
  const args = parseArgs();
  const inputPath = String(args.input || "ingest/out/jobs.json");
  const write = !!args.write;
  const token = process.env.CF_D1_TOKEN || "";

  const raw = JSON.parse(await readFile(inputPath, "utf8"));
  const candidates = Array.isArray(raw) ? raw : (raw.jobs || []);
  const existing = (await (await fetch(READ_API, { headers: { "cache-control": "no-cache" } })).json()).jobs || [];

  const { fresh, rejected } = decide(candidates, existing);

  process.stdout.write(`candidates: ${candidates.length}\n`);
  process.stdout.write(`already in D1: ${existing.length}\n`);
  for (const [k, v] of Object.entries(rejected)) process.stdout.write(`  rejected ${k}: ${v}\n`);
  process.stdout.write(`NEW and eligible: ${fresh.length}\n\n`);
  for (const r of fresh.slice(0, 40)) {
    process.stdout.write(`${String(r.match_pct).padStart(3)}  ${String(r.company).slice(0, 24).padEnd(24)} ${String(r.title).slice(0, 52)}\n`);
  }
  if (fresh.length > 40) process.stdout.write(`... and ${fresh.length - 40} more\n`);

  if (!write) {
    process.stdout.write(`\nDRY RUN. Nothing written. Re-run with --write to insert.\n`);
  } else if (!token) {
    process.stdout.write(`\nCF_D1_TOKEN is not set. Nothing written.\n`);
    process.exitCode = 1;
  } else {
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    let written = 0;
    for (let i = 0; i < fresh.length; i += 25) {
      const chunk = fresh.slice(i, i + 25);
      const values = chunk.map(r => `(${[
        sq(r.dedupe_key), sq(r.company), sq(r.title), sq(r.url), r.match_pct ?? "NULL",
        sq(r.source), sq("queued"), sq(r.lane || "ft"), sq(r.posted), sq(r.work_type), sq(now)
      ].join(", ")})`).join(",\n");
      const sql = `INSERT OR IGNORE INTO jobs
        (dedupe_key, company, title, url, match_pct, source, status, lane, posted, work_type, updated_at)
        VALUES\n${values}`;
      const out = await d1(token, sql);
      if (!out.success) {
        process.stdout.write(`\nINSERT FAILED at row ${i}: ${JSON.stringify(out.errors)}\n`);
        process.exitCode = 1;
        break;
      }
      written += chunk.length;
    }
    process.stdout.write(`\nwrote ${written} rows to D1\n`);
  }
}
