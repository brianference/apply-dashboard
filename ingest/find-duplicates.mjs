/**
 * Report queued postings that are the same job under different dedupe_keys.
 *
 * upsert.mjs's within-batch check (normalizedJobKey) only catches a duplicate
 * scraped twice in the SAME ingest run. It cannot catch Hopper's case: the
 * direct Ashby posting queued on the 24th, the same job re-appearing via the
 * Jobspresso aggregator on the 29th -- five days and two ingest runs apart,
 * with dedupe_keys that never collided. This script closes that gap by
 * checking the full live queue instead of one run's batch.
 *
 * Read-only: fetches the public /api/jobs endpoint and never writes anything.
 * Never connects to a database, same as upsert.mjs.
 *
 *   node ingest/find-duplicates.mjs
 */
import { normalizedJobKey } from './match.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';

/**
 * @param {Array<{ dedupe_key: string, company: string, title: string, status: string }>} jobs
 * @returns {Array<Array<{ dedupe_key: string, company: string, title: string }>>}
 */
export function findQueuedDuplicates(jobs) {
  const queued = jobs.filter((j) => j.status === 'queued');
  const byKey = new Map();
  for (const j of queued) {
    const key = normalizedJobKey(j.company, j.title);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(j);
  }
  return [...byKey.values()].filter((group) => group.length > 1);
}

async function main() {
  const { jobs } = await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json();
  const groups = findQueuedDuplicates(jobs || []);
  if (!groups.length) {
    console.log('no duplicate queued postings found');
    return;
  }
  console.log(`${groups.length} duplicate group(s) in the queue:\n`);
  for (const group of groups) {
    console.log(`${group[0].company} -- ${group.length} copies`);
    for (const j of group) console.log(`  ${j.dedupe_key}  (${j.title})`);
    console.log('');
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
