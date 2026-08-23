import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "companies.json");

/**
 * Load verified ATS board tokens.
 *
 * @returns {Promise<{ greenhouse: Array<{token:string,name:string}>, lever: Array<{token:string,name:string}>, ashby: Array<{token:string,name:string}> }>}
 */
export async function loadCompanies() {
  const raw = JSON.parse(await readFile(FILE, "utf8"));
  return {
    greenhouse: Array.isArray(raw.greenhouse) ? raw.greenhouse : [],
    lever: Array.isArray(raw.lever) ? raw.lever : [],
    ashby: Array.isArray(raw.ashby) ? raw.ashby : []
  };
}
