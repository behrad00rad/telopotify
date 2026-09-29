import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createGateway } from './gateway.mjs';

test('the remote gateway protects bridge routes and never exposes its local token', async () => {
  const server = createGateway('long-test-password-for-gateway');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/web`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /telopotify/);
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/audio/123`, {headers: {Range: 'bytes=0-99'}})).status, 401);

    const wrong = await fetch(`${base}/web/login`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: base},
      body: JSON.stringify({password: 'wrong'})});
    assert.equal(wrong.status, 401);
    const crossSite = await fetch(`${base}/web/login`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: 'https://other.example'},
      body: JSON.stringify({password: 'long-test-password-for-gateway'})});
    assert.equal(crossSite.status, 403);

    const login = await fetch(`${base}/web/login`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: base},
      body: JSON.stringify({password: 'long-test-password-for-gateway'})});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await fetch(`${base}/web/session`, {headers: {Cookie: cookie}})
      .then(response => response.json())).authenticated, true);
    assert.equal((await fetch(`${base}/bootstrap`, {headers: {Cookie: cookie}})).status, 404);
    const logout = await fetch(`${base}/web/logout`, {method: 'POST',
      headers: {Cookie: cookie, Origin: base}});
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${base}/status`, {headers: {Cookie: cookie}})).status, 401);
  } finally { server.close(); }
});
