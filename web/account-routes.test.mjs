import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {createMultiuserServer} from './multiuser.mjs';
import {AttemptLimiter, trustedProxyAddresses} from './rate-limit.mjs';
import {AccountStore} from './accounts.mjs';

async function withServer(options, work) {
  const dir = await mkdtemp(resolve(tmpdir(), 'telopotify-routes-'));
  const {prepare, ...serverOptions} = options;
  if (prepare) await prepare(dir);
  const server = await createMultiuserServer({dataDir: dir, sessionKey: randomBytes(32).toString('base64'),
    allowSignups: true, ...serverOptions});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie, headers = {}) => fetch(base + path, {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: base, ...(cookie ? {Cookie: cookie} : {}), ...headers},
    body: JSON.stringify(body)});
  const session = cookie => fetch(base + '/web/session', {headers: {Cookie: cookie}}).then(r => r.json());
  try { await work({dir, base, post, session}); }
  finally { await new Promise(done => server.close(done)); await rm(dir, {recursive: true, force: true}); }
}

test('password changes and recovery invalidate web sessions while preserving library and playlists', () => withServer({}, async ({dir, post, session}) => {
  const credentials = {username: 'music_user', password: 'original-password-123'};
  const registered = await post('/web/register', credentials);
  assert.equal(registered.status, 200);
  const initialCode = (await registered.json()).recoveryCode;
  const cookie1 = registered.headers.get('set-cookie');
  const login2 = await post('/web/login', credentials); const cookie2 = login2.headers.get('set-cookie');
  const another = await post('/web/register', {username: 'other_user', password: 'other-password-123'});
  const otherCookie = another.headers.get('set-cookie');
  assert.equal((await session(cookie1)).recoveryCode, undefined);
  assert.equal((await post('/web/password', {currentPassword: 'wrong', newPassword: 'new-password-123'}, cookie1)).status, 403);
  assert.equal((await session(cookie2)).authenticated, true);
  const changed = await post('/web/password', {currentPassword: credentials.password, newPassword: 'new-password-123'}, cookie1);
  assert.equal(changed.status, 200); const cookie3 = changed.headers.get('set-cookie');
  assert.equal((await session(cookie1)).authenticated, false);
  assert.equal((await session(cookie2)).authenticated, false);
  assert.equal((await session(cookie3)).authenticated, true);
  assert.equal((await post('/web/recovery-code', {currentPassword: 'wrong'}, cookie3)).status, 403);
  const replacement = await post('/web/recovery-code', {currentPassword: 'new-password-123'}, cookie3);
  assert.equal(replacement.status, 200); const code = (await replacement.json()).recoveryCode;
  assert.equal((await post('/web/recover', {username: credentials.username, recoveryCode: initialCode, newPassword: 'recovered-password-123'})).status, 400);
  const saved = JSON.parse(await readFile(resolve(dir, 'accounts.json'), 'utf8'));
  const id = saved.accounts.find(a => a.username === credentials.username).id;
  const userDir = resolve(dir, 'users', id); await mkdir(userDir, {recursive: true});
  for (const name of ['collections.json', 'bridge-library.json', 'telegram.session']) await writeFile(resolve(userDir, name), 'preserved');
  const recovered = await post('/web/recover', {username: credentials.username, recoveryCode: code, newPassword: 'recovered-password-123'});
  assert.equal(recovered.status, 200); const nextCode = (await recovered.json()).recoveryCode;
  assert.notEqual(nextCode, code);
  assert.equal((await session(cookie3)).authenticated, false);
  assert.equal((await session(otherCookie)).authenticated, true);
  assert.equal((await post('/web/login', {username: credentials.username, password: 'new-password-123'})).status, 401);
  assert.equal((await post('/web/login', {username: credentials.username, password: 'recovered-password-123'})).status, 200);
  assert.equal((await post('/web/recover', {username: credentials.username, recoveryCode: code, newPassword: 'next-password-123'})).status, 400);
  for (const name of ['collections.json', 'bridge-library.json', 'telegram.session']) assert.equal(await readFile(resolve(userDir, name), 'utf8'), 'preserved');
  assert.equal((await readFile(resolve(dir, 'accounts.json'), 'utf8')).includes(nextCode), false);
}));

test('login and recovery isolate forwarded clients only with an explicitly trusted proxy', async () => {
  await withServer({trustedProxies: trustedProxyAddresses('127.0.0.1'), limiter: new AttemptLimiter({limit: 2})}, async ({post}) => {
    const header = ip => ({'X-Forwarded-For': ip});
    const wrong = {username: 'first', password: 'wrong'};
    const responses = await Promise.all([1, 2, 3].map(() => post('/web/login', wrong, null, header('198.51.100.1'))));
    assert.deepEqual(responses.map(r => r.status).sort(), [401, 401, 429]);
    assert.ok(responses.find(r => r.status === 429).headers.get('retry-after'));
    assert.equal((await post('/web/login', {username: 'second', password: 'wrong'}, null, header('198.51.100.2'))).status, 401);
    const recovery = {username: 'first', recoveryCode: 'wrong', newPassword: 'new-password-123'};
    for (let i = 0; i < 2; i++) assert.equal((await post('/web/recover', recovery, null, header('198.51.100.1'))).status, 400);
    assert.equal((await post('/web/recover', recovery, null, header('198.51.100.1'))).status, 429);
    assert.equal((await post('/web/recover', {...recovery, username: 'second'}, null, header('198.51.100.2'))).status, 400);
    // Username limits also prevent distributed attempts from evading the lockout.
    assert.equal((await post('/web/recover', recovery, null, header('198.51.100.3'))).status, 429);
  });
  await withServer({trustedProxies: new Set(), limiter: new AttemptLimiter({limit: 1})}, async ({post}) => {
    assert.equal((await post('/web/login', {username: 'a', password: 'bad'}, null, {'X-Forwarded-For': '198.51.100.1'})).status, 401);
    assert.equal((await post('/web/login', {username: 'b', password: 'bad'}, null, {'X-Forwarded-For': '198.51.100.2'})).status, 429);
  });
});

test('recovery works with closed registration and malformed input never echoes credentials', async () => {
  let code;
  await withServer({allowSignups: false, prepare: async dir => {
    const store = new AccountStore(resolve(dir, 'accounts.json'));
    code = (await store.register('existing', 'original-password-123')).recoveryCode;
  }}, async ({base, post}) => {
    assert.equal((await post('/web/register', {username: 'new_user', password: 'new-password-123'})).status, 403);
    const response = await post('/web/recover', {username: 'existing', recoveryCode: code, newPassword: 'recovered-password-123'});
    assert.equal(response.status, 200);
    assert.ok((await response.json()).recoveryCode);
    const malformed = await fetch(base + '/web/login', {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: base}, body: '{"password":"sensitive-test-marker",'});
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {error: 'Invalid JSON request'});
  });
});

test('an open audio response prevents idle cleanup; its closed bridge restarts on demand', async () => {
  let upstreamResponse, starts = 0, stops = 0, now = 0;
  const upstream = createServer((req, res) => {
    if (req.url.startsWith('/audio/')) { upstreamResponse = res; res.writeHead(200, {'Content-Type': 'audio/mpeg'}); res.write('audio'); }
    else { res.setHeader('Content-Type', 'application/json'); res.end('{}'); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  try {
    await withServer({cleanupIntervalMs: 10, poolOptions: {maxProcesses: 1, idleMs: 100, now: () => now},
      startBridge: async () => { starts++; return {address: new URL(`http://127.0.0.1:${upstream.address().port}?token=test-only`), stop: async () => { stops++; }}; }},
    async ({base, post}) => {
      const login = await post('/web/register', {username: 'listener', password: 'listener-password-123'});
      const cookie = login.headers.get('set-cookie');
      const stream = await fetch(base + '/audio/1', {headers: {Cookie: cookie}});
      now = 1000; await delay(50); assert.equal(stops, 0);
      await stream.body.cancel();
      await delay(50); now = 2000;
      for (let i = 0; i < 30 && stops === 0; i++) await delay(10);
      assert.equal(stops, 1);
      assert.equal((await fetch(base + '/status', {headers: {Cookie: cookie}})).status, 200);
      assert.equal(starts, 2);
    });
  } finally {
    upstreamResponse?.destroy(); upstream.closeAllConnections(); await new Promise(done => upstream.close(done));
  }
});
