import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createMultiuserServer, webListenAddress } from './multiuser.mjs';

test('web listener defaults to loopback and accepts hosting port settings', () => {
  assert.deepEqual(webListenAddress({}), {host: '127.0.0.1', port: 43129});
  assert.deepEqual(webListenAddress({TELOPOTIFY_WEB_HOST: '0.0.0.0', PORT: '8080'}),
    {host: '0.0.0.0', port: 8080});
  assert.deepEqual(webListenAddress({TELOPOTIFY_WEB_PORT: '9000', PORT: '8080'}),
    {host: '127.0.0.1', port: 9000});
  assert.throws(() => webListenAddress({PORT: 'invalid'}), /must be an integer/);
});

test('new web accounts are closed unless the owner enables registration', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'telopotify-closed-signups-'));
  const server = await createMultiuserServer({dataDir: dir,
    sessionKey: randomBytes(32).toString('base64'), allowSignups: false});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await (await fetch(`${base}/web/session`)).json();
    assert.equal(session.registrationOpen, false);
    const register = await fetch(`${base}/web/register`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: base},
      body: JSON.stringify({username: 'new_user', password: 'strong-password-123'})});
    assert.equal(register.status, 403);
  } finally {
    await new Promise(done => server.close(done));
    await rm(dir, {recursive: true, force: true});
  }
});

test('web accounts keep bridge routes and data separate', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'telopotify-web-test-'));
  const mock = resolve(dir, 'mock-bridge.mjs');
  await writeFile(mock, `import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const folder=process.env.TELOPOTIFY_DATA_DIR;
const server=createServer((req,res)=>{const u=new URL(req.url,'http://localhost');
if(u.searchParams.get('token')!=='bridge-secret'){res.writeHead(401);res.end();return;}
res.setHeader('Content-Type','application/json');res.end(JSON.stringify({folder,path:u.pathname,
sessionKeyReady:Buffer.from(process.env.TELOPOTIFY_SESSION_KEY||'','base64').length===32}));});
server.listen(0,'127.0.0.1',async()=>{await mkdir(folder,{recursive:true});
await writeFile(resolve(folder,'bridge-connection.json'),JSON.stringify({address:'http://127.0.0.1:'+server.address().port+'?token=bridge-secret'}));});`);
  const server = await createMultiuserServer({dataDir: resolve(dir, 'accounts'), bridgeScript: mock,
    sessionKey: randomBytes(32).toString('base64'), allowSignups: true});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie) => fetch(base + path, {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: base, ...(cookie ? {Cookie: cookie} : {})},
    body: JSON.stringify(body)});
  try {
    assert.equal((await fetch(base + '/status')).status, 401);
    const first = await post('/web/register', {username: 'first_user', password: 'first-password-123'});
    const second = await post('/web/register', {username: 'second_user', password: 'second-password-123'});
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const cookie1 = first.headers.get('set-cookie');
    const cookie2 = second.headers.get('set-cookie');
    assert.match(cookie1, /HttpOnly; Secure; SameSite=Strict/);
    const status1 = await fetch(base + '/status', {headers: {Cookie: cookie1}});
    const status2 = await fetch(base + '/status', {headers: {Cookie: cookie2}});
    assert.equal(status1.status, 200);
    assert.equal(status2.status, 200);
    const body1 = await status1.json();
    const body2 = await status2.json();
    assert.notEqual(body1.folder, body2.folder);
    assert.equal(body1.path, '/status');
    assert.equal(body1.sessionKeyReady, true);
    assert.equal(body2.sessionKeyReady, true);
    assert.equal((await fetch(base + '/bootstrap', {headers: {Cookie: cookie1}})).status, 404);
    assert.equal((await post('/web/login', {username: 'first_user', password: 'wrong-password'})).status, 401);
    const login = await post('/web/login', {username: 'first_user', password: 'first-password-123'});
    assert.equal(login.status, 200);
    assert.equal((await fetch(base + '/web/session', {headers: {Cookie: login.headers.get('set-cookie')}})
      .then(response => response.json())).authenticated, true);
    const stored = JSON.parse(await readFile(resolve(dir, 'accounts/accounts.json'), 'utf8'));
    assert.equal(stored.accounts.length, 2);
    assert.equal(JSON.stringify(stored).includes('first-password-123'), false);
  } finally {
    await new Promise(done => server.close(done));
    await rm(dir, {recursive: true, force: true});
  }
});
