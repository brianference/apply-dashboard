/**
 * The portfolio's data calls. No credentials: this page is public by design.
 */

/**
 * Whose portfolio this page is showing.
 *
 * `/portfolio/magnus` is the address a person hands out, so the handle is read
 * from the path first. `?u=magnus` still works because it is what the API took
 * before pretty URLs existed and links to it may already be in the wild.
 *
 * With neither, this returns null and the API falls back to the first profile
 * ever created. That fallback is why every account's portfolio used to render
 * the owner's: this page never sent a handle at all, so the API answered with
 * the only thing it could.
 *
 * @returns {string|null}
 */
export function currentHandle() {
  const fromPath = location.pathname.match(/^\/portfolio\/([^/]+)\/?$/);
  if (fromPath) {
    const candidate = decodeURIComponent(fromPath[1]);
    /* index.html is served at this path too; it names a file, not a person. */
    if (candidate && !candidate.includes(".")) return candidate;
  }
  const fromQuery = new URLSearchParams(location.search).get("u");
  return fromQuery ? fromQuery.trim() : null;
}

/**
 * @returns {Promise<object>} the curated public profile
 */
export async function fetchProfile() {
  const handle = currentHandle();
  const url = handle ? `/api/portfolio?u=${encodeURIComponent(handle)}` : "/api/portfolio";
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}
