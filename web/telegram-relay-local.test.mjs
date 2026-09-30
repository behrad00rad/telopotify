import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {relayEnabled, startTelegramRelay} from './telegram-relay-local.mjs';

test('relay can be explicitly enabled or disabled', () => {
  assert.equal(relayEnabled(undefined, undefined), false);
  assert.equal(relayEnabled(undefined, 'wss://relay.example'), true);
  assert.equal(relayEnabled('0', 'wss://relay.example'), false);
  assert.equal(relayEnabled('false', 'wss://relay.example'), false);
  assert.equal(relayEnabled('1', undefined), true);
  assert.throws(() => relayEnabled('maybe', 'wss://relay.example'), /must be 1 or 0/);
});

test('relay rejects invalid configuration and non-Telegram SOCKS destinations', async () => {
  await assert.rejects(startTelegramRelay('http://example.com', 'short'), /wss:\/\//);
  const relay = await startTelegramRelay('wss://example.workers.dev', 'a'.repeat(40));
  try {
    const socket = connect(relay.address().port, '127.0.0.1');
    const replies = [];
    socket.on('data', part => replies.push(part));
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(Buffer.from([5, 1, 0]));
    await new Promise(resolve => setTimeout(resolve, 20));
    socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 1, 187]));
    await new Promise(resolve => socket.once('end', resolve));
    assert.deepEqual(Buffer.concat(replies).subarray(0, 2), Buffer.from([5, 0]));
    assert.equal(Buffer.concat(replies)[3], 2);
  } finally { relay.close(); }
});
