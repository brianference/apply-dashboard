import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { logError } from "./logger.mjs";

/**
 * True when this module is the process entry point.
 *
 * @param {string} metaUrl
 * @returns {boolean}
 */
export function isCli(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(resolve(entry)).href;
}

/**
 * Parse `--flag value` and `--flag=value` arguments.
 *
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[body] = next;
      i += 1;
    } else {
      out[body] = true;
    }
  }
  return out;
}

/**
 * @param {{ id: string, name: string, homepage: string, kind: string, license: string }} meta
 * @param {(opts: { limit?: number, query?: string }) => Promise<unknown[]>} fetchJobs
 * @param {string[]} argv
 */
export async function runSourceCli(meta, fetchJobs, argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `Usage: node ingest/sources/${meta.id}.mjs [--query TEXT] [--limit N]\n` +
        `Source: ${meta.name} (${meta.kind})\n` +
        `Homepage: ${meta.homepage}\n` +
        `License: ${meta.license}\n`
    );
    return;
  }
  const args = parseArgs(argv);
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  const query = args.query === true ? "" : args.query;
  try {
    const jobs = await fetchJobs({
      limit: Number.isFinite(limit) ? limit : undefined,
      query: query ? String(query) : undefined
    });
    process.stdout.write(JSON.stringify({ meta, count: jobs.length, jobs }, null, 2) + "\n");
  } catch (error) {
    logError("source failed", { id: meta.id, error: String(error && error.message ? error.message : error) });
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
