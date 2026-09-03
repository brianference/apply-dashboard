import { loadCompanies } from "../companies.mjs";
import { isCli, runSourceCli } from "../cli.mjs";
import { fetchJson, mapPool, settle } from "../http.mjs";
import { filterJobs, isoFromUnknown, joinWorkType } from "../jobs.mjs";

export const meta = {
  id: "oracle",
  name: "Oracle Recruiting Cloud (Candidate Experience)",
  homepage: "https://docs.oracle.com/en/cloud/saas/talent-management/",
  kind: "ats",
  license: "public candidate-experience JSON; no key"
};

/* One page is capped server-side; ask for a round number and walk offsets. */
export const PAGE_SIZE = 50;
const MAX_PAGES = 12;

/**
 * Oracle names workplace types by code. The label is what reaches work_type,
 * because "ORA_ON_SITE" in a column a person reads is not a location.
 */
const WORKPLACE_LABEL = {
  ORA_REMOTE: "Remote",
  ORA_HYBRID: "Hybrid",
  ORA_ON_SITE: "On-site",
  ORA_ONSITE: "On-site"
};

/**
 * Build the requisition-list URL for one tenant site.
 *
 * The finder is a semicolon-delimited parameter list rather than normal query
 * pairs, so its commas and semicolons must survive unencoded; only the values
 * inside it are escaped.
 *
 * @param {{ host: string, site: string }} board
 * @param {{ query?: string, limit?: number, offset?: number }} [options]
 * @returns {string}
 */
export function requisitionListUrl(board, options = {}) {
  const keyword = String(options.query || "").trim();
  const limit = Number.isFinite(options.limit) ? options.limit : PAGE_SIZE;
  const offset = Number.isFinite(options.offset) ? options.offset : 0;
  const finder = [
    `siteNumber=${encodeURIComponent(board.site)}`,
    keyword ? `keyword=${encodeURIComponent(keyword)}` : null,
    `limit=${limit}`,
    `offset=${offset}`,
    "sortBy=POSTING_DATES_DESC"
  ].filter(Boolean).join(",");
  return `https://${board.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
    + `?onlyData=true&expand=requisitionList&finder=findReqs;${finder}`;
}

/**
 * Public posting URL for one requisition.
 *
 * @param {{ host: string, site: string }} board
 * @param {string|number} id
 * @returns {string}
 */
export function jobUrl(board, id) {
  return `https://${board.host}/hcmUI/CandidateExperience/en/sites/`
    + `${encodeURIComponent(board.site)}/job/${encodeURIComponent(String(id))}`;
}

/**
 * The requisition array sits one level down, inside a search-state object that
 * also carries the facets and the total. An empty or shape-shifted payload
 * yields an empty array rather than throwing.
 *
 * @param {unknown} payload
 * @returns {{ list: object[], total: number|null }}
 */
export function requisitionsFrom(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  const state = items[0] || {};
  const list = Array.isArray(state.requisitionList) ? state.requisitionList : [];
  const total = Number.isFinite(state.TotalJobsCount) ? state.TotalJobsCount : null;
  return { list, total };
}

/**
 * Map an Oracle requisition list onto the shared posting shape.
 *
 * @param {unknown} payload
 * @param {{ companyName: string, host: string, site: string }} board
 * @returns {Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null, refreshed_at: string|null }>}
 */
export function normalizeOracleJobs(payload, board) {
  const { list } = requisitionsFrom(payload);
  const companyName = board && board.companyName ? board.companyName : "";
  return list.map((job) => {
    const id = job && job.Id != null ? String(job.Id) : "";
    return {
      company: companyName,
      title: job && job.Title ? String(job.Title) : "",
      /* No id, no posting: an unaddressable row would dedupe against itself
         and link nowhere, so it is dropped downstream by filterJobs. */
      url: id ? jobUrl(board, id) : "",
      source: "oracle",
      work_type: joinWorkType(
        WORKPLACE_LABEL[String(job && job.WorkplaceTypeCode || "").toUpperCase()],
        job && job.PrimaryLocation
      ),
      posted: job && job.PostedDate ? isoFromUnknown(job.PostedDate) : null,
      /* Oracle publishes one date. Claiming a refresh it never reported would
         make every requisition look permanently fresh to the stale lens. */
      refreshed_at: null
    };
  });
}

/**
 * Walk one tenant's offsets until the page comes back short or the cap is hit.
 *
 * @param {{ host: string, site: string, name: string }} board
 * @param {{ query?: string, limit?: number }} options
 * @param {(url: string) => Promise<unknown>} get
 * @returns {Promise<object[]>}
 */
export async function fetchBoardJobs(board, options, get) {
  const collected = [];
  const want = Number.isFinite(options.limit) && options.limit > 0
    ? options.limit
    : PAGE_SIZE * MAX_PAGES;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = requisitionListUrl(board, {
      query: options.query,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE
    });
    const payload = await get(url);
    const { list } = requisitionsFrom(payload);
    collected.push(...normalizeOracleJobs(payload, {
      companyName: board.name,
      host: board.host,
      site: board.site
    }));
    if (list.length < PAGE_SIZE) break;
    if (collected.length >= want) break;
  }
  return collected;
}

/**
 * Fetch published requisitions from every configured Oracle tenant.
 *
 * @param {{ limit?: number, query?: string, fetchJson?: (url: string) => Promise<unknown> }} [options]
 * @returns {Promise<Array<{ company: string, title: string, url: string, source: string, work_type: string|null, posted: string|null, refreshed_at: string|null }>>}
 */
export async function fetchJobs(options = {}) {
  const boards = (await loadCompanies()).oracle;
  const get = options.fetchJson || fetchJson;
  const collected = [];
  await mapPool(boards, 2, async (board) => {
    const jobs = await settle(
      `oracle:${board.host}/${board.site}`,
      () => fetchBoardJobs(board, options, get),
      []
    );
    collected.push(...jobs);
  });
  return filterJobs(collected, options);
}

if (isCli(import.meta.url)) {
  await runSourceCli(meta, fetchJobs);
}
