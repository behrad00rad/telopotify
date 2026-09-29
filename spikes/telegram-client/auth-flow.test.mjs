import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthFlow } from './auth-flow.mjs';

test('sign-in progresses through code and two-step password without exposing values in state', async () => {
  let saved = false;
  const client = {
    async start(callbacks) {
      assert.equal(await callbacks.phoneNumber(), '+15555550123');
      assert.equal(await callbacks.phoneCode(), '12345');
      assert.equal(await callbacks.password(), 'private-password');
    },
  };
  const flow = createAuthFlow(client, async () => { saved = true; });
  const done = flow.begin('+15555550123');
  await Promise.resolve();
  assert.equal(flow.state().step, 'code');
  flow.submit('code', '12345');
  await Promise.resolve();
  assert.equal(flow.state().step, 'password');
  flow.submit('password', 'private-password');
  await done;
  assert.equal(flow.state().step, 'authorized');
  assert.equal(saved, true);
  assert.equal(JSON.stringify(flow.state()).includes('private-password'), false);
});

test('rejects invalid phone numbers and an input for the wrong step', () => {
  const flow = createAuthFlow({ start() {} }, async () => {});
  assert.throws(() => flow.begin('123'), /international format/);
  assert.throws(() => flow.submit('code', '12345'), /not active/);
});

test('stops retrying non-recoverable Telegram login errors', async () => {
  let retries = 0;
  const client = { async start(callbacks) {
    retries++;
    const failure = { errorMessage: 'FLOOD_WAIT_60' };
    if (await callbacks.onError(failure)) throw failure;
    retries++;
  } };
  const flow = createAuthFlow(client, async () => {});
  await flow.begin('+15555550123');
  assert.equal(retries, 1);
  assert.equal(flow.state().step, 'phone');
  assert.match(flow.state().error, /wait/);
});

test('reports a session save failure after Telegram authorization without exposing credentials', async () => {
  const client = {async start(callbacks) {
    assert.equal(await callbacks.phoneNumber(), '+15555550123');
    assert.equal(await callbacks.phoneCode(), '12345');
  }};
  const flow = createAuthFlow(client, async () => {
    const error = new Error('spawn EPERM');
    error.code = 'EPERM';
    throw error;
  });
  const done = flow.begin('+15555550123');
  await Promise.resolve();
  flow.submit('code', '12345');
  await done;
  assert.equal(flow.state().step, 'phone');
  assert.match(flow.state().error, /could not save your session/i);
  assert.equal(flow.state().diagnostic, 'EPERM');
  assert.equal(JSON.stringify(flow.state()).includes('12345'), false);
});
