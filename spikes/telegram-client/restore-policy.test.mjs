import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { restoreDelay, shouldRetryRestore } from './restore-policy.mjs';

test('network failures retry with bounded backoff but revoked sessions require sign-in', () => {
  assert.equal(shouldRetryRestore(new Error('connect ECONNREFUSED 149.154.167.92:443')), true);
  assert.equal(shouldRetryRestore(new Error('AUTH_KEY_UNREGISTERED')), false);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(restoreDelay),
    [5000, 10000, 20000, 40000, 60000, 60000]);
});
