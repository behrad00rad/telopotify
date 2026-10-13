import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AttemptLimiter, clientAddress, trustedProxyAddresses} from './rate-limit.mjs';

const request = (peer, forwarded) => ({socket: {remoteAddress: peer}, headers: {'x-forwarded-for': forwarded}});
test('forwarded IPs are ignored by default, and trusted chains stop at the first untrusted hop', () => {
  const trust = trustedProxyAddresses('127.0.0.1,::1,192.0.2.1');
  assert.equal(clientAddress(request('127.0.0.1', '198.51.100.1')), '127.0.0.1');
  assert.equal(clientAddress(request('::ffff:127.0.0.1', '198.51.100.1'), trust), '198.51.100.1');
  assert.equal(clientAddress(request('203.0.113.1', '198.51.100.1'), trust), '203.0.113.1');
  assert.equal(clientAddress(request('127.0.0.1', 'spoofed,198.51.100.1'), trust), '127.0.0.1');
  assert.equal(clientAddress(request('127.0.0.1', '198.51.100.99,203.0.113.1,192.0.2.1'), trust), '203.0.113.1');
  assert.throws(() => trustedProxyAddresses('*'), /exact IP/);
});
test('rate limits reserve concurrent attempts, isolate clients, expire, and bound memory', () => {
  let now = 0;
  const limiter = new AttemptLimiter({limit: 2, windowMs: 10_000, maxEntries: 2, now: () => now});
  assert.equal(limiter.take('client-a'), 0); assert.equal(limiter.take('client-a'), 0);
  assert.equal(limiter.take('client-a'), 10); assert.equal(limiter.take('client-b'), 0);
  assert.equal(limiter.take('client-c'), 10);
  now = 10_000;
  assert.equal(limiter.take('client-c'), 0); assert.equal(limiter.entries.size, 1);
});
