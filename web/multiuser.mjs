import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AccountStore } from './accounts.mjs';
import { relayEnabled, startTelegramRelay } from './telegram-relay-local.mjs';

const files = new Map([
  ['/web', [resolve('web/index.html'), 'text/html; charset=utf-8']],
  ['/web/', [resolve('web/index.html'), 'text/html; charset=utf-8']],
  ['/web/app.js', [resolve('web/app.js'), 'text/javascript; charset=utf-8']],
  ['/web/styles.css', [resolve('web/styles.css'), 'text/css; charset=utf-8']],
  ['/web/logo.png', [resolve('TelopotifyApp/assets/telopotify-logo.png'), 'image/png']],
]);
const apiPaths = new Set(['/status', '/reconnect', '/auth/start', '/auth/input', '/auth/cancel', '/auth/logout',
  '/channels', '/channels/select', '/library', '/library/sync', '/collections']);
const lifetime = 7 * 24 * 60 * 60 * 1000;

export function webListenAddress(env = process.env) {
  const host = env.TELOPOTIFY_WEB_HOST || '127.0.0.1';
  const portText = env.TELOPOTIFY_WEB_PORT || env.PORT || '43129';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('TELOPOTIFY_WEB_PORT (or PORT) must be an integer from 1 to 65535');
  }
  return {host, port};
}

function send(response, status, value, headers = {}) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...headers});
  response.end(JSON.stringify(value));
}
function sameOrigin(request) {
  if (!request.headers.origin) return true;
  try { return new URL(request.headers.origin).host === request.headers.host; }
  catch { return false; }
}
async function bodyOf(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Expected JSON');
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 4096) throw new Error('Request is too large');
  }
  return JSON.parse(text);
}
function cookie(value, maxAge) {
  return `telopotify_account=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
function validSessionKey(value) {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('TELOPOTIFY_SESSION_KEY must be a base64-encoded 32-byte key');
  }
  return value;
}
async function sessionKeyFor(dataDir) {
  if (process.env.TELOPOTIFY_SESSION_KEY) return validSessionKey(process.env.TELOPOTIFY_SESSION_KEY);
  if (process.platform !== 'win32') {
    throw new Error('Set TELOPOTIFY_SESSION_KEY before hosting Telegram sessions on this platform');
  }
  // Local Windows development must not depend on spawning PowerShell from a
  // web worker. Keep the key in ignored account data so sessions survive restarts.
  const keyPath = resolve(dataDir, 'session.key');
  await mkdir(dataDir, {recursive: true});
  try { return validSessionKey((await readFile(keyPath, 'utf8')).trim()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = randomBytes(32).toString('base64');
  try { await writeFile(keyPath, value, {flag: 'wx', mode: 0o600}); return value; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return validSessionKey((await readFile(keyPath, 'utf8')).trim());
}

export async function createMultiuserServer({dataDir = resolve('local-data/web-accounts'),
  bridgeScript = resolve('spikes/telegram-client/library-server.mjs'), sessionKey: suppliedSessionKey,
  allowSignups = process.env.TELOPOTIFY_ALLOW_SIGNUPS === '1'} = {}) {
  const sessionKey = suppliedSessionKey ? validSessionKey(suppliedSessionKey) : await sessionKeyFor(dataDir);
  const store = new AccountStore(resolve(dataDir, 'accounts.json'));
  await store.load();
  const relayUrl = process.env.TELOPOTIFY_RELAY_URL;
  const relay = relayEnabled(process.env.TELOPOTIFY_RELAY_ENABLED, relayUrl) ?
    await startTelegramRelay(relayUrl, process.env.TELOPOTIFY_RELAY_TOKEN) : null;
  const relayPort = relay?.address().port;
  const sessions = new Map();
  const failures = new Map();
  const bridges = new Map();
  const accountFor = request => {
    const key = request.headers.cookie?.match(/(?:^|;\s*)telopotify_account=([a-f0-9]{64})(?:;|$)/)?.[1];
    const session = key && sessions.get(key);
    if (!session) return null;
    if (session.expires < Date.now()) { sessions.delete(key); return null; }
    return session;
  };
  async function bridgeFor(accountId) {
    if (bridges.has(accountId)) return bridges.get(accountId).ready;
    const entry = {child: null, ready: null};
    bridges.set(accountId, entry);
    entry.ready = (async () => {
      const userDir = resolve(dataDir, 'users', accountId);
      await mkdir(userDir, {recursive: true});
      const connectionFile = resolve(userDir, 'bridge-connection.json');
      await unlink(connectionFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const child = spawn(process.execPath, [bridgeScript], {
        cwd: resolve('.'), windowsHide: true, stdio: 'ignore',
        env: {...process.env, TELOPOTIFY_DATA_DIR: userDir, TELOPOTIFY_BRIDGE_PORT: '0',
          TELOPOTIFY_SESSION_KEY: sessionKey,
          TELOPOTIFY_SOCKS_PORT: relayPort ? String(relayPort) : ''},
      });
      entry.child = child;
      let spawnError = null;
      child.on('error', error => { spawnError = error; if (bridges.get(accountId) === entry) bridges.delete(accountId); });
      child.on('exit', () => { if (bridges.get(accountId) === entry) bridges.delete(accountId); });
      for (let attempt = 0; attempt < 150; attempt++) {
        if (spawnError) throw new Error('Telegram service could not start');
        if (child.exitCode !== null) throw new Error('Telegram service stopped');
        try {
          const saved = JSON.parse(await readFile(connectionFile, 'utf8'));
          const address = new URL(saved.address);
          if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' ||
              !address.searchParams.get('token')) throw new Error('Invalid Telegram service address');
          return address;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(done => setTimeout(done, 100));
      }
      child.kill();
      throw new Error('Telegram service did not start');
    })();
    entry.ready.catch(() => { if (bridges.get(accountId) === entry) bridges.delete(accountId); });
    return entry.ready;
  }
  async function proxy(request, response, url, accountId) {
    const address = await bridgeFor(accountId);
    const target = new URL(url.pathname + url.search, address.origin);
    target.searchParams.set('token', address.searchParams.get('token'));
    const headers = {};
    if (request.headers.range) headers.range = request.headers.range;
    if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    const upstream = await fetch(target, {method: request.method, headers,
      body: request.method === 'POST' ? JSON.stringify(await bodyOf(request)) : undefined,
      signal: abort.signal});
    const outgoing = {'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer'};
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges',
      'cache-control', 'x-content-type-options']) {
      const value = upstream.headers.get(name);
      if (value) outgoing[name] = value;
    }
    response.writeHead(upstream.status, outgoing);
    if (request.method === 'HEAD' || !upstream.body) { response.end(); return; }
    Readable.fromWeb(upstream.body).on('error', () => response.destroy()).pipe(response);
  }
  const server = createServer(async (request, response) => {
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
        const session = accountFor(request);
        send(response, 200, {remote: true, multiuser: true, authenticated: Boolean(session),
          username: session?.username || null, registrationOpen: allowSignups}); return;
      }
      if (request.method === 'POST' && !sameOrigin(request)) {
        send(response, 403, {error: 'Invalid request origin'}); return;
      }
      if (request.method === 'POST' && ['/web/register', '/web/login'].includes(url.pathname)) {
        if (url.pathname === '/web/register' && !allowSignups) {
          send(response, 403, {error: 'Account registration is closed. Ask the server owner to enable it.'}); return;
        }
        const key = request.socket.remoteAddress || 'unknown';
        const recent = (failures.get(key) || []).filter(time => time > Date.now() - 15 * 60_000);
        if (recent.length >= 12) { send(response, 429, {error: 'Too many attempts. Try later.'}); return; }
        let account;
        try {
          const {username, password} = await bodyOf(request);
          account = url.pathname === '/web/register' ? await store.register(username, password) :
            await store.verify(username, password);
        } catch (error) {
          failures.set(key, [...recent, Date.now()]);
          send(response, 400, {error: error.message}); return;
        }
        if (!account) {
          failures.set(key, [...recent, Date.now()]);
          send(response, 401, {error: 'Incorrect username or password'}); return;
        }
        failures.delete(key);
        const secret = randomBytes(32).toString('hex');
        sessions.set(secret, {id: account.id, username: account.username, expires: Date.now() + lifetime});
        send(response, 200, {authenticated: true}, {'Set-Cookie': cookie(secret, lifetime / 1000)});
        return;
      }
      const session = accountFor(request);
      if (!session) { send(response, 401, {error: 'Sign in to your web account first'}); return; }
      if (url.pathname === '/web/logout' && request.method === 'POST') {
        const key = request.headers.cookie.match(/telopotify_account=([a-f0-9]{64})/)?.[1];
        if (key) sessions.delete(key);
        send(response, 200, {authenticated: false}, {'Set-Cookie': cookie('', 0)}); return;
      }
      if (!(apiPaths.has(url.pathname) || /^\/(audio|artwork)\/\d+$/.test(url.pathname)) ||
          !['GET', 'POST', 'HEAD'].includes(request.method)) {
        send(response, 404, {error: 'Not found'}); return;
      }
      await proxy(request, response, url, session.id);
    } catch (error) {
      if (!response.headersSent) send(response, 502, {error: 'Service unavailable. Try again shortly.'});
      else response.destroy();
      console.error('Web account request failed:', error.message);
    }
  });
  server.on('close', () => {
    for (const {child} of bridges.values()) child?.kill();
    relay?.close();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createMultiuserServer();
  const {host, port} = webListenAddress();
  server.listen(port, host, () => {
    console.log(`Multi-user web app listening on ${host}:${port}; open /web through an HTTPS address.`);
    console.log(`Telegram relay: ${relayEnabled(process.env.TELOPOTIFY_RELAY_ENABLED,
      process.env.TELOPOTIFY_RELAY_URL) ? 'on' : 'off'}`);
    console.log(`New account registration: ${process.env.TELOPOTIFY_ALLOW_SIGNUPS === '1' ? 'on' : 'off'}`);
    console.log('Use HTTPS to expose port 43129; the Telegram API credentials here remain test-only.');
  });
}
