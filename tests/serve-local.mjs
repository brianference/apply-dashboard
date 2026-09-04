/**
 * Serve the built .deploy directory and proxy /api/* to production.
 *
 * The page is a static file plus API calls. Driving it before a deploy means
 * serving the local build and answering /api/jobs from the live site -- a
 * server that only serves files leaves the list empty, and pointing the
 * browser at production tests the old deploy.
 *
 *   node tests/serve-local.mjs
 *   node tests/serve-local.mjs --dir C:\temp\broken-deploy
 *
 * Prints the URL it is listening on.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'https://apply-dashboard.pages.dev';

/* The same header rules Pages applies, so a policy that holds in production
   holds here too. Without this the local server sent no CSP and a check that a
   blob: image is refused passed against production and failed locally. */
import { loadHeaderRules, headersFor } from './headers-file.mjs';

const args = process.argv.slice(2);
let dir = path.join(ROOT, '.deploy');
let port = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && args[i + 1]) { dir = path.resolve(args[++i]); continue; }
  if (args[i] === '--port' && args[i + 1]) { port = Number(args[++i]) || 0; continue; }
}

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error('FAIL  no built directory at ' + dir + ' -- run ./build-deploy.sh first');
  process.exit(1);
}
if (!fs.existsSync(path.join(dir, 'index.html'))) {
  console.error('FAIL  ' + dir + ' has no index.html');
  process.exit(1);
}

const HEADER_RULES = loadHeaderRules(dir);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

/**
 * Resolve a request path onto the served directory. Rejects paths that
 * walk above it -- serving `../.env` from a local server is how a test
 * helper becomes a secret dump.
 * @param {string} urlPath
 * @returns {string|null}
 */
function fileFor(urlPath) {
  let rel = decodeURIComponent((urlPath || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const resolved = path.resolve(dir, '.' + path.posix.normalize('/' + rel.replace(/^\/+/, '')));
  const root = path.resolve(dir);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) return null;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const index = path.join(resolved, 'index.html');
    if (fs.existsSync(index) && fs.statSync(index).isFile()) return index;
    return null;
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  return null;
}

/**
 * @param {string} file
 * @returns {string}
 */
function mime(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/')) {
    try {
      const incoming = new URL(url, 'http://127.0.0.1');
      const target = UPSTREAM + incoming.pathname + incoming.search;
      const headers = {
        accept: req.headers.accept || 'application/json',
        'accept-encoding': 'identity'
      };
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      if (req.headers['x-apply-token']) headers['x-apply-token'] = req.headers['x-apply-token'];
      if (req.headers.cookie) headers.cookie = req.headers.cookie;
      const body = await readBody(req);
      const init = { method: req.method, headers };
      if (body.length && req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
      const up = await fetch(target, init);
      const buf = Buffer.from(await up.arrayBuffer());
      const out = { 'content-length': String(buf.length) };
      const ct = up.headers.get('content-type');
      if (ct) out['content-type'] = ct;
      res.writeHead(up.status, out);
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('proxy failed: ' + e.message);
    }
    return;
  }
  const file = fileFor(url);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': mime(file), ...headersFor(HEADER_RULES, url) });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const bound = addr && typeof addr === 'object' ? addr.port : port;
  console.log('http://127.0.0.1:' + bound);
});
