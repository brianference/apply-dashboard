/**
 * GET /portfolio/<handle> — serve the portfolio page for one account.
 *
 * The page itself is static and identical for everyone; only the data differs,
 * and the page fetches that from /api/portfolio using the handle in its own URL.
 * So this route does not render anything. It answers with the portfolio's
 * index.html and lets the page read the path.
 *
 * Why a Function rather than a `_redirects` rewrite: a placeholder rewrite and
 * the static asset server both want to answer /portfolio/*, and which one wins
 * is not something to guess at. A Function on `[handle]` matches exactly one
 * path segment, which is precisely the set of URLs that should be handled here.
 * /portfolio/js/main.js is two segments and never reaches this file.
 *
 * A handle that does not exist is NOT a 404 here. The page asks the API, and the
 * API decides; rendering "no such portfolio" in the product's own layout beats
 * an edge 404, and it keeps the decision in one place.
 */

/**
 * Anything with a dot in it is a file, not a handle.
 *
 * Handles are validated on the way in and cannot contain a dot, so this only
 * ever catches a request for an asset that happens to sit directly under
 * /portfolio/ — index.html among them. Those are passed to the asset server
 * untouched rather than being answered with the page.
 */
const LOOKS_LIKE_A_FILE = /\./;

/**
 * @param {{params: {handle: string}, request: Request, env: {ASSETS: {fetch: (r: Request) => Promise<Response>}}, next: () => Promise<Response>}} context
 * @returns {Promise<Response>}
 */
export async function onRequestGet(context) {
  const { params, request, env, next } = context;
  const handle = String(params.handle || "");

  if (!handle || LOOKS_LIKE_A_FILE.test(handle)) return next();

  const page = new URL(request.url);
  page.pathname = "/portfolio/index.html";
  page.search = "";

  const res = await env.ASSETS.fetch(new Request(page.toString(), { headers: request.headers }));
  /* Re-wrapped so the status and body are this route's, not a cached asset
     response the browser might treat as belonging to /portfolio/index.html. */
  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "text/html; charset=utf-8",
      /* Same reasoning as the dashboard: this is a live view of a row that the
         owner edits, and a stale render shows an old headline to a recruiter. */
      "cache-control": "no-store"
    }
  });
}
