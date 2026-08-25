/**
 * Work the whole queue overnight without stalling.
 *
 * The bash supervisor hung twice: three shell processes stayed alive with no
 * batch running and the timeline frozen on round 1 for fifty-two minutes,
 * because a curl or a powershell subprocess blocked with no timeout. Everything
 * here has a hard deadline and the loop cannot block on any single step.
 *
 *   node apply/run-all-night.mjs
 *   node apply/run-all-night.mjs --rounds 40
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const TIMELINE = path.join(ROOT, 'evidence', 'apply', 'night-timeline.log');
const LANES = [
  { host: 'ashbyhq', log: 'night-ashby.log', pace: '6000' },
  { host: 'myworkdayjobs', log: 'night-workday.log', pace: '4000' },
];

const argv = process.argv.slice(2);
const MAX_ROUNDS = Number(argv[argv.indexOf('--rounds') + 1]) || 60;
const BATCH_MS = 45 * 60 * 1000;   // a lane gets 45 minutes, then it is killed
const IDLE_LIMIT = 5;

/** @param {string} msg */
function say(msg) {
  const line = `${new Date().toISOString().slice(11, 19)}Z ${msg}`;
  console.log(line);
  try { fs.appendFileSync(TIMELINE, line + '\n'); } catch { /* logging must never stop the run */ }
}

/**
 * Read D1 with a deadline. Returns null rather than hanging.
 * @returns {Promise<object[]|null>}
 */
async function jobs() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(API, { signal: ctrl.signal, headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) return null;
    return (await r.json()).jobs;
  } catch { return null; } finally { clearTimeout(t); }
}

/**
 * Run one command to completion or kill it at the deadline.
 * @param {string} cmd @param {string[]} args @param {object} opts
 * @returns {Promise<number>} exit code, or -1 when it was killed
 */
function run(cmd, args, { ms = BATCH_MS, env = {}, out = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(killed || code === null ? -1 : code);
    };
    /* A SIGKILLed child closes with code null, and the close handler fires
       before the fallback, so the caller saw null rather than -1 and could not
       tell "killed" from "exited". Mark it, then normalise in finish. */
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      say(`  step exceeded ${ms < 60000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60000) + 'm'}, killing it`);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      setTimeout(() => finish(-1), 8000);
    }, ms);
    if (out) {
      const stream = fs.createWriteStream(path.join(ROOT, 'evidence', 'apply', out), { flags: 'a' });
      child.stdout.pipe(stream);
      child.stderr.pipe(stream);
    } else {
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
    }
    child.on('close', finish);
    child.on('error', () => finish(-1));
  });
}

/** Kill the runner's Chrome instances and delete the throwaway profiles. */
async function sweep() {
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*apply-session*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ], { ms: 60000 });
  try {
    for (const n of fs.readdirSync(ROOT)) {
      if (n.startsWith('.apply-session-')) fs.rmSync(path.join(ROOT, n), { recursive: true, force: true, maxRetries: 2 });
    }
  } catch { /* a locked profile dir is not worth stopping for */ }
}

const countFor = (list, host) => list.filter(j => j.status === 'queued' && new RegExp(host, 'i').test(j.url || '')).length;
const submitted = (list) => list.filter(j => j.status === 'submitted').length;

/* Importing this file must not start a run. The simulation below exercises the
   helpers directly, and a test that boots the real overnight loop would be a
   test that applies to real jobs. */
const IS_MAIN = !!(process.argv[1] && process.argv[1].split('\\').join('/').endsWith('apply/run-all-night.mjs'));
export { run, sweep, jobs, say };
if (!IS_MAIN) { /* imported for testing */ } else {
let idle = 0;
let round = 0;
const first = await jobs();
if (!first) { say('D1 unreachable at start; refusing to run blind'); process.exit(1); }
say(`starting: ${submitted(first)} submitted, ${first.filter(j => j.status === 'queued').length} queued`);

while (round < MAX_ROUNDS) {
  round += 1;
  const before = await jobs();
  if (!before) { say(`round ${round}: D1 unreachable, waiting 2m`); await new Promise(r => setTimeout(r, 120000)); continue; }

  const counts = LANES.map(l => `${l.host.replace('myworkdayjobs', 'workday').replace('ashbyhq', 'ashby')} ${countFor(before, l.host)}`);
  const start = submitted(before);
  say(`round ${round} | ${counts.join(' | ')} | submitted ${start}`);

  if (LANES.every(l => countFor(before, l.host) === 0)) { say('no queued postings left on a lane the runner can complete'); break; }

  /* Only genuinely transient states come back. A posting retired as terminal
     stays retired, so one bad posting cannot be picked round after round. */
  await run(process.execPath, [path.join(ROOT, 'apply', 'clear-retryable.local.mjs')], { ms: 60000 });

  for (const lane of LANES) {
    if (countFor(before, lane.host) === 0) continue;
    say(`  ${lane.host}...`);
    await run(process.execPath,
      [path.join(ROOT, 'apply', 'batch.mjs'), '--submit', '--goal', '500', '--host', lane.host],
      { env: { PACE_MS: lane.pace }, out: lane.log });
    await sweep();
  }

  const after = await jobs();
  const end = after ? submitted(after) : start;
  if (end > start) { idle = 0; say(`round ${round}: ${start} -> ${end}`); }
  else {
    idle += 1;
    say(`round ${round} added nothing (idle ${idle}/${IDLE_LIMIT})`);
    if (idle >= IDLE_LIMIT) { say('everything reachable is applied to or blocked; stopping'); break; }
    await new Promise(r => setTimeout(r, 90000));
  }
  await new Promise(r => setTimeout(r, 15000));
}

const last = await jobs();
say(`finished after ${round} round(s): ${last ? submitted(last) : '?'} submitted`);
}
