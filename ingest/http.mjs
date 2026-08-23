import { logWarn } from "./logger.mjs";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const USER_AGENT = "apply-dashboard-ingest/0.1 (+https://apply-dashboard.pages.dev)";

/**
 * Fetch a URL as text with a timeout and a stable User-Agent.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: Record<string, string>, accept?: string }} [options]
 * @returns {Promise<{ url: string, finalUrl: string, status: number, contentType: string, text: string }>}
 */
export async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    "user-agent": USER_AGENT,
    accept: options.accept || "application/json, application/rss+xml, application/xml, text/xml, */*;q=0.8",
    ...(options.headers || {})
  };
  let response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status === 429) {
      const retryAfterRaw = response.headers.get("retry-after");
      const retryMs = Math.min(10_000, Math.max(1_000, (Number(retryAfterRaw) || 2) * 1000));
      logWarn("HTTP 429, retrying once", { url, retryMs });
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs)
      });
    }
  } catch (error) {
    const reason = error && error.name === "TimeoutError"
      ? `timeout after ${timeoutMs}ms`
      : String(error && error.message ? error.message : error);
    throw new Error(`GET ${url} failed: ${reason}`);
  }
  const text = await response.text();
  return {
    url,
    finalUrl: response.url,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    text
  };
}

/**
 * Fetch JSON. Throws on non-2xx or non-JSON bodies.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: Record<string, string> }} [options]
 * @returns {Promise<unknown>}
 */
export async function fetchJson(url, options = {}) {
  const result = await fetchText(url, {
    ...options,
    accept: "application/json"
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`GET ${url} returned HTTP ${result.status}`);
  }
  try {
    return JSON.parse(result.text);
  } catch (error) {
    throw new Error(`GET ${url} did not return JSON: ${String(error && error.message ? error.message : error)}`);
  }
}

/**
 * Run async work over items with a concurrency cap.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Keep a source fetch from taking down the whole run.
 *
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function settle(label, fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    logWarn("source fetch failed", { label, error: String(error && error.message ? error.message : error) });
    return fallback;
  }
}
