/**
 * The portfolio's data calls. No credentials: this page is public by design.
 */

/**
 * @returns {Promise<object>} the curated public profile
 */
export async function fetchProfile() {
  const res = await fetch("/api/portfolio", { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`/api/portfolio returned ${res.status}`);
  return res.json();
}
