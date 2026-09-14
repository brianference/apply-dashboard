/**
 * Read an employer's mail convention off its public commit metadata and record
 * the SHAPE in contacts.json.
 *
 * The addresses themselves are never written anywhere. What lands in the file
 * is a shape, a count and the repositories the count came from, so the claim on
 * the page can be checked by anyone who wants to re-run this. This repository
 * is public, which is exactly why the personal data stops here.
 *
 *   node ingest/email-sweep.mjs            write the patterns
 *   node ingest/email-sweep.mjs --dry      print what it would write
 *
 * Uses the gh CLI, which is already authenticated; an unauthenticated caller
 * hits GitHub's 60-requests-an-hour limit within one employer.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { derivePattern } from './email-pattern.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'web', 'outreach', 'data', 'contacts.json');
const GH = process.env.GH_PATH || 'C:/Program Files/GitHub CLI/gh.exe';

/** Employer key in contacts.json -> its GitHub org and mail domain. */
const EMPLOYERS = [
  { key: 'Docker', org: 'docker', domain: 'docker.com' },
  { key: 'ZipRecruiter', org: 'ZipRecruiter', domain: 'ziprecruiter.com' },
  { key: 'LawnStarter', org: 'lawnstarter', domain: 'lawnstarter.com' },
  { key: 'Jerry.ai', org: 'getjerry', domain: 'getjerry.com' },
  { key: 'MoneyGram', org: 'MoneyGram', domain: 'moneygram.com' },
  { key: 'BillingPlatform', org: 'BillingPlatform', domain: 'billingplatform.com' },
  { key: 'Clarium', org: 'clariumhealth', domain: 'clariumhealth.com' },
  { key: 'Lexipol', org: 'lexipol', domain: 'lexipol.com' },
  { key: 'Arity', org: 'arity', domain: 'arity.com' },
  { key: 'Deepgram', org: 'deepgram', domain: 'deepgram.com' },
  { key: 'Pinterest', org: 'pinterest', domain: 'pinterest.com' },
  { key: 'Netflix', org: 'Netflix', domain: 'netflix.com' },
  { key: 'Tremendous', org: 'tremendous-rewards', domain: 'tremendous.com' },
  { key: 'Filevine', org: 'filevine', domain: 'filevine.com' },
  { key: 'MeridianLink', org: 'meridianlink', domain: 'meridianlink.com' },
  { key: 'Vanta', org: 'VantaInc', domain: 'vanta.com' },
  { key: 'RevenueCat', org: 'RevenueCat', domain: 'revenuecat.com' },
  { key: 'Camunda', org: 'camunda', domain: 'camunda.com' },
  { key: 'Samsara', org: 'samsara-dev', domain: 'samsara.com' }
];

/** How many of an org's most recently pushed repositories to read. */
const REPOS = 8;

/**
 * One gh api call, returning [] rather than throwing on a 404 org.
 *
 * @param {string} endpoint
 * @param {string} jq
 * @returns {Promise<string[]>}
 */
async function gh(endpoint, jq) {
  try {
    const { stdout } = await run(GH, ['api', endpoint, '-q', jq], {
      maxBuffer: 1024 * 1024 * 32,
      env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' }
    });
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Every commit-author address on an org's recent repositories, filtered to its
 * own domain.
 *
 * @param {{ org: string, domain: string }} employer
 * @returns {Promise<{ addresses: string[], repos: string[] }>}
 */
async function addressesFor({ org, domain }) {
  const repos = (await gh(`orgs/${org}/repos?per_page=${REPOS}&sort=pushed`, '.[].full_name'))
    .slice(0, REPOS);
  const addresses = [];
  const used = [];
  for (const repo of repos) {
    const found = (await gh(`repos/${repo}/commits?per_page=100`, '.[].commit.author.email'))
      .filter((a) => a.toLowerCase().endsWith(`@${domain}`));
    if (found.length) used.push(repo.split('/')[1]);
    addresses.push(...found);
  }
  return { addresses, repos: used };
}

const dry = process.argv.includes('--dry');
const file = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
let wrote = 0;

for (const employer of EMPLOYERS) {
  const company = file.companies[employer.key];
  if (!company) {
    console.log(`${employer.key.padEnd(16)} not in contacts.json, skipped`);
    continue;
  }
  const { addresses, repos } = await addressesFor(employer);
  const result = derivePattern(addresses);

  const block = result.ok
    ? {
      domain: employer.domain,
      shape: result.shape,
      unique: result.unique,
      agree: result.agree,
      pct: result.pct,
      evidence: `${result.agree} of ${result.unique} unique ${employer.domain} addresses in public `
        + `commit metadata (${repos.join(', ')}) use ${result.shape}`,
      checked: today
    }
    : {
      domain: employer.domain,
      shape: null,
      unique: result.unique,
      reason: result.reason,
      evidence: repos.length
        ? `read ${repos.join(', ')}; not enough agreement to state a convention`
        : 'no public repository exposes an address on this domain',
      checked: today
    };

  console.log(`${employer.key.padEnd(16)} ${result.ok ? block.shape.padEnd(11) : 'none'.padEnd(11)}`
    + ` ${String(result.unique).padStart(3)} unique  ${result.reason}`);
  if (!dry) {
    company.email = block;
    wrote++;
  }
}

if (!dry) {
  fs.writeFileSync(DATA, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  console.log(`\nwrote an email block for ${wrote} employers`);
  const text = fs.readFileSync(DATA, 'utf8');
  /* The one thing that must never end up in a public file. */
  const leaked = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  const personal = leaked.filter((a) => !/^(careers|press|info|support|hello)@/i.test(a));
  console.log(personal.length
    ? `FAIL: ${personal.length} address(es) written to the file: ${personal.slice(0, 3).join(', ')}`
    : 'no individual address was written to the file');
  if (personal.length) process.exitCode = 1;
} else {
  console.log('\ndry run, nothing written');
}
