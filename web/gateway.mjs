import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const PORT = 43128;
const files = new Map([
  ['/web', [resolve('web/index.html'), 'text/html; charset=utf-8']],
  ['/web/', [resolve('web/index.html'), 'text/html; charset=utf-8']],
  ['/web/app.js', [resolve('web/app.js'), 'text/javascript; charset=utf-8']],
  ['/web/styles.css', [resolve('web/styles.css'), 'text/css; charset=utf-8']],
  ['/web/logo.png', [resolve('TelopotifyApp/assets/telopotify-logo.png'), 'image/png']],
]);
const apiPaths = new Set(['/status', '/reconnect', '/auth/start', '/auth/input',
  '/channels', '/channels/select', '/library', '/library/sync', '/collections']);
const hash = value => createHash('sha256').update(value).digest();
const sessions = new Map();
const failures = new Map();
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;

function send(response, status, body, headers = {}) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...headers});
  response.end(JSON.stringify(body));
}
function sessionFor(request) {
  const raw = request.headers.cookie?.match(/(?:^|;\s*)telopotify_web=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!raw) return null;
  const expiry = sessions.get(raw);
  if (!expiry) return null;
  if (expiry < Date.now()) { sessions.delete(raw); return null; }
  return raw;
}
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; }
  catch { return false; }
}
async function bodyOf(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 512 * 1024) throw new Error('Request is too large');
  }
  return body;
}
async function bridgeAddress() {
  const saved = JSON.parse(await readFile(resolve('local-data/bridge-connection.json'), 'utf8'));
  const address = new URL(saved.address);
  if (address.hostname !== '127.0.0.1' || address.port !== '43127' ||
      address.protocol !== 'http:' || !address.searchParams.get('token')) {
    throw new Error('Local Telegram service is unavailable');
  }
  return address;
}
async function proxy(request, response, url) {
  const address = await bridgeAddress();
  const target = new URL(url.pathname + url.search, address.origin);
  target.searchParams.set('token', address.searchParams.get('token'));
  const headers = {};
  if (request.headers.range) headers.range = request.headers.range;
  if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  const upstream = await fetch(target, {method: request.method, headers,
    body: request.method === 'POST' ? await bodyOf(request) : undefined,
    signal: controller.signal});
  const allowedHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges',
    'cache-control', 'x-content-type-options'];
  const outgoing = {'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer'};
  allowedHeaders.forEach(name => { const value = upstream.headers.get(name); if (value) outgoing[name] = value; });
  response.writeHead(upstream.status, outgoing);
  if (request.method === 'HEAD' || !upstream.body) { response.end(); return; }
  Readable.fromWeb(upstream.body).on('error', () => response.destroy()).pipe(response);
}
export function createGateway(password) {
  if (typeof password !== 'string' || password.length < 16) {
    throw new Error('Set TELOPOTIFY_WEB_PASSWORD to at least 16 characters');
  }
  const expected = hash(password);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/' && request.method === 'GET') {
        response.writeHead(302, {Location: '/web'}); response.end(); return;
      }
      if (files.has(url.pathname) && request.method === 'GET') {
        const [path, mime] = files.get(url.pathname);
        const bytes = await readFile(path);
        response.writeHead(200, {'Content-Type': mime, 'Content-Length': bytes.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'"});
        response.end(bytes); return;
      }
      if (url.pathname === '/web/session' && request.method === 'GET') {
        send(response, 200, {remote: true, authenticated: Boolean(sessionFor(request))}); return;
      }
      if (request.method === 'POST' && !sameOrigin(request)) {
        send(response, 403, {error: 'Invalid request origin'}); return;
      }
      if (url.pathname === '/web/login' && request.method === 'POST') {
        const key = request.socket.remoteAddress || 'unknown';
        const recent = (failures.get(key) || []).filter(time => time > Date.now() - 15 * 60 * 1000);
        if (recent.length >= 8) { send(response, 429, {error: 'Too many attempts. Try again later.'}); return; }
        const body = await bodyOf(request);
        const value = JSON.parse(body).password;
        const provided = hash(typeof value === 'string' ? value : '');
        if (!timingSafeEqual(expected, provided)) {
          failures.set(key, [...recent, Date.now()]);
          send(response, 401, {error: 'Incorrect password'}); return;
        }
        failures.delete(key);
        const session = randomBytes(32).toString('hex');
        sessions.set(session, Date.now() + sessionLifetime);
        send(response, 200, {authenticated: true}, {'Set-Cookie':
          `telopotify_web=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}`});
        return;
      }
      const session = sessionFor(request);
      if (!session) { send(response, 401, {error: 'Sign in to the web player first'}); return; }
      if (url.pathname === '/web/logout' && request.method === 'POST') {
        sessions.delete(session);
        send(response, 200, {authenticated: false}, {'Set-Cookie':
          'telopotify_web=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'}); return;
      }
      if (!(apiPaths.has(url.pathname) || /^\/(audio|artwork)\/\d+$/.test(url.pathname)) ||
          !['GET', 'POST', 'HEAD'].includes(request.method)) {
        send(response, 404, {error: 'Not found'}); return;
      }
      await proxy(request, response, url);
    } catch (error) {
      if (!response.headersSent) send(response, 502, {error: error.message});
      else response.destroy();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createGateway(process.env.TELOPOTIFY_WEB_PASSWORD);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Password-protected web gateway ready at http://127.0.0.1:${PORT}/web`);
    console.log('Expose this gateway through an HTTPS tunnel; keep port 43127 private.');
  });
}
