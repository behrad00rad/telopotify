import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AccountStore } from './accounts.mjs';
import { relayEnabled, startTelegramRelay } from './telegram-relay-local.mjs';
import {AttemptLimiter, clientAddress, trustedProxyAddresses} from './rate-limit.mjs';
import {BridgePool, bridgeLimits} from './bridge-pool.mjs';
import {telegramCredentials} from '../spikes/telegram-client/credentials.mjs';

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
  allowSignups = process.env.TELOPOTIFY_ALLOW_SIGNUPS === '1',
  trustedProxies = trustedProxyAddresses(process.env.TELOPOTIFY_TRUSTED_PROXIES),
  limiter = new AttemptLimiter(), poolOptions = bridgeLimits(), startBridge: suppliedStartBridge,
  cleanupIntervalMs = 60_000} = {}) {
  const sessionKey = suppliedSessionKey ? validSessionKey(suppliedSessionKey) : await sessionKeyFor(dataDir);
  const store = new AccountStore(resolve(dataDir, 'accounts.json'));
  await store.load();
  const relayUrl = process.env.TELOPOTIFY_RELAY_URL;
  const relay = relayEnabled(process.env.TELOPOTIFY_RELAY_ENABLED, relayUrl) ?
    await startTelegramRelay(relayUrl, process.env.TELOPOTIFY_RELAY_TOKEN) : null;
  const relayPort = relay?.address().port;
  const sessions = new Map();
  const accountFor = request => {
    const key = request.headers.cookie?.match(/(?:^|;\s*)telopotify_account=([a-f0-9]{64})(?:;|$)/)?.[1];
    const session = key && sessions.get(key);
    if (!session) return null;
    if (session.expires <= Date.now() || session.sessionVersion !== store.sessionVersion(session.id)) {
      sessions.delete(key); return null;
    }
    return session;
  };
  const invalidateSessions = id => {
    for (const [key, session] of sessions) if (session.id === id) sessions.delete(key);
  };
  const issueSession = account => {
    const secret = randomBytes(32).toString('hex');
    sessions.set(secret, {...account, expires: Date.now() + lifetime});
    // Never keep a one-time recovery code inside session state.
    delete sessions.get(secret).recoveryCode;
    return cookie(secret, lifetime / 1000);
  };
  function limited(request, response, action, username) {
    const keys = [`${action}:ip:${clientAddress(request, trustedProxies)}`];
    if (username !== undefined) keys.push(`${action}:user:${String(username).trim().toLowerCase().slice(0, 32)}`);
    for (const key of keys) {
      const retry = limiter.take(key);
      if (retry) {
        send(response, 429, {error: 'Too many attempts. Please wait before trying again.'}, {'Retry-After': retry});
        return true;
      }
    }
    return false;
  }
  async function startBridge(accountId, onExit) {
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
    let spawnError = null;
    let exited = false;
    const stopped = new Promise(done => {
      child.on('error', error => {
        spawnError = error;
        if (!child.pid) { exited = true; onExit(); done(); }
      });
      child.on('exit', () => { exited = true; onExit(); done(); });
    });
    const stop = async () => {
      if (!exited && !child.kill()) throw new Error('Telegram service could not stop');
      await stopped;
    };
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (spawnError) throw new Error('Telegram service could not start');
        if (exited) throw new Error('Telegram service stopped');
        try {
          const saved = JSON.parse(await readFile(connectionFile, 'utf8'));
          const address = new URL(saved.address);
          if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' ||
              !address.searchParams.get('token')) throw new Error('Invalid Telegram service address');
          return {address, stop};
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await new Promise(done => setTimeout(done, 100));
      }
      throw new Error('Telegram service did not start');
    } catch (error) { await stop(); throw error; }
  }
  const pool = new BridgePool(suppliedStartBridge || startBridge, poolOptions);
  const cleanupTimer = setInterval(() => {
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
    pool.cleanup().catch(() => {});
  }, cleanupIntervalMs);
  cleanupTimer.unref();
  async function proxy(request, response, url, accountId) {
    const lease = await pool.acquire(accountId);
    const {address} = lease;
    response.once('finish', lease.release);
    response.once('close', lease.release);
    if (response.destroyed) { lease.release(); return; }
    try {
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
    } catch (error) { lease.release(); throw error; }
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
      if (url.pathname === '/web/recover' && request.method === 'POST') {
        if (limited(request, response, 'recover')) return;
        const {username, recoveryCode, newPassword} = await bodyOf(request);
        const retry = limiter.take(`recover:user:${String(username || '').trim().toLowerCase().slice(0, 32)}`);
        if (retry) { send(response, 429, {error: 'Too many attempts. Please wait before trying again.'}, {'Retry-After': retry}); return; }
        const account = await store.recover(username, recoveryCode, newPassword);
        if (!account) { send(response, 400, {error: 'Incorrect username or recovery code'}); return; }
        invalidateSessions(account.id);
        send(response, 200, {authenticated: false, recoveryCode: account.recoveryCode},
          {'Set-Cookie': cookie('', 0)}); return;
      }
      if (request.method === 'POST' && ['/web/register', '/web/login'].includes(url.pathname)) {
        if (url.pathname === '/web/register' && !allowSignups) {
          send(response, 403, {error: 'Account registration is closed. Ask the server owner to enable it.'}); return;
        }
        if (limited(request, response, 'login')) return;
        let account;
        try {
          const {username, password} = await bodyOf(request);
          const retry = limiter.take(`login:user:${String(username || '').trim().toLowerCase().slice(0, 32)}`);
          if (retry) { send(response, 429, {error: 'Too many attempts. Please wait before trying again.'}, {'Retry-After': retry}); return; }
          account = url.pathname === '/web/register' ? await store.register(username, password) :
            await store.verify(username, password);
        } catch (error) {
          if (error.code || error instanceof SyntaxError) throw error;
          send(response, 400, {error: error.message}); return;
        }
        if (!account) {
          send(response, 401, {error: 'Incorrect username or password'}); return;
        }
        if (account.sessionVersion !== store.sessionVersion(account.id)) {
          send(response, 409, {error: 'Account credentials changed. Please sign in again.'}); return;
        }
        send(response, 200, {authenticated: true, ...(account.recoveryCode ? {recoveryCode: account.recoveryCode} : {})},
          {'Set-Cookie': issueSession(account)});
        return;
      }
      const session = accountFor(request);
      if (!session) { send(response, 401, {error: 'Sign in to your web account first'}); return; }
      if (request.method === 'POST' && ['/web/password', '/web/recovery-code'].includes(url.pathname)) {
        if (limited(request, response, 'confirm', session.username)) return;
        const {currentPassword, newPassword} = await bodyOf(request);
        const result = url.pathname === '/web/password' ?
          await store.changePassword(session.id, currentPassword, newPassword) :
          await store.replaceRecovery(session.id, currentPassword);
        if (!result) { send(response, 403, {error: 'Current password is incorrect'}); return; }
        if (url.pathname === '/web/password') {
          invalidateSessions(session.id);
          send(response, 200, {authenticated: true}, {'Set-Cookie': issueSession(result)});
        } else send(response, 200, result);
        return;
      }
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
      const malformed = error instanceof SyntaxError;
      const inputError = malformed || /^(Expected JSON|Request is too large|Password must be)/.test(error.message);
      if (!response.headersSent) send(response, inputError ? 400 : error.status || 502,
        {error: malformed ? 'Invalid JSON request' : inputError || error.status === 503 ? error.message : 'Service unavailable. Try again shortly.'},
        error.status === 503 ? {'Retry-After': '30'} : {});
      else response.destroy();
      if (!inputError) console.error('Web account request failed:', error.code || 'SERVICE_ERROR');
    }
  });
  server.on('close', () => {
    clearInterval(cleanupTimer);
    pool.close().catch(() => {});
    relay?.close();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  telegramCredentials();
  const server = await createMultiuserServer();
  const {host, port} = webListenAddress();
  server.listen(port, host, () => {
    console.log(`Multi-user web app listening on ${host}:${port}; open /web through an HTTPS address.`);
    console.log(`Telegram relay: ${relayEnabled(process.env.TELOPOTIFY_RELAY_ENABLED,
      process.env.TELOPOTIFY_RELAY_URL) ? 'on' : 'off'}`);
    console.log(`New account registration: ${process.env.TELOPOTIFY_ALLOW_SIGNUPS === '1' ? 'on' : 'off'}`);
    console.log('Invite-only development beta. Use HTTPS for remote access.');
  });
  const shutdown = () => { server.closeAllConnections(); server.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
