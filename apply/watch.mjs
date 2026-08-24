/**
 * Orchestrator. Verifies real progress against D1 - never a worker's own
 * self-report - and relaunches the campaign if every shard dies before the
 * goal is met. Appends a timestamped timeline so progress is auditable.
 *
 *   node apply/watch.mjs --goal 100
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const TIMELINE = path.join(ROOT, 'evidence', 'apply', 'progress-timeline.log');
const DIRECT = /ashbyhq|greenhouse|lever\.co|workable|smartrecruiters|myworkdayjobs|icims/i;

const GOAL = Number((process.argv.find(a => a.startsWith('--goal='))
  || '--goal=100').split('=')[1]);

/** @param {string} line */
function note(line) {
  const s = `${new Date().toISOString()} ${line}\n`;
  fs.mkdirSync(path.dirname(TIMELINE), { recursive: true });
  fs.appendFileSync(TIMELINE, s);
  console.log(s.trim());
}

/** @returns {number} how many batch.mjs workers are alive */
function workersAlive() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*batch.mjs*' }).Count"
    ], { encoding: 'utf8', timeout: 20000 });
    return Number(String(out).trim()) || 0;
  } catch { return 0; }
}

/** @returns {Promise<{submitted:number, queued:number}|null>} live truth from D1 */
async function snapshot() {
  try {
    const r = await fetch(API, { headers: { 'cache-control': 'no-cache' } });
    const { jobs } = await r.json();
    return {
      submitted: jobs.filter(j => j.lane === 'submitted').length,
      queued: jobs.filter(j => j.status === 'queued' && DIRECT.test(j.url || '')).length
    };
  } catch { return null; }
}

note(`orchestrator started, goal=${GOAL}`);
let lastSubmitted = null;
let stalledChecks = 0;

for (;;) {
  const snap = await snapshot();
  const alive = workersAlive();

  if (!snap) {
    note('D1 unreachable, retrying in 2m');
  } else {
    note(`submitted=${snap.submitted} direct_queue=${snap.queued} workers=${alive}`);

    if (snap.submitted >= GOAL) {
      note(`GOAL MET (${snap.submitted} >= ${GOAL})`);
      break;
    }

    /* Relaunch when every worker has died but there is still work left. */
    if (alive === 0 && snap.queued > 0) {
      note(`all workers down with ${snap.queued} still queued - relaunching 5 shards`);
      spawn('bash', [path.join(ROOT, 'apply', 'overnight.sh'), String(GOAL), '5'],
        { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    }

    /* Detect a silent stall: workers alive but the real number is not moving. */
    if (lastSubmitted !== null && snap.submitted === lastSubmitted && alive > 0) {
      stalledChecks++;
      if (stalledChecks >= 5) {
        note(`STALL: ${stalledChecks} checks with no new submission while ${alive} workers ran - killing so the relaunch path can take over`);
        try {
          execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*batch.mjs*' -or $_.CommandLine -like '*runner.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*apply-session*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
          ], { timeout: 30000 });
        } catch { /* best effort */ }
        stalledChecks = 0;
      }
    } else {
      stalledChecks = 0;
    }
    lastSubmitted = snap.submitted;
  }

  await new Promise(r => setTimeout(r, 120000));
}
