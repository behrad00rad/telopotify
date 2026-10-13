import assert from 'node:assert/strict';
import {test} from 'node:test';
import {telegramCredentials} from './credentials.mjs';

test('Telegram credentials require explicit configuration and errors never echo values', () => {
  assert.throws(() => telegramCredentials({}), /Configure TELOPOTIFY_API_ID/);
  const apiHash = 'a'.repeat(32);
  assert.deepEqual(telegramCredentials({TELOPOTIFY_API_ID: '123', TELOPOTIFY_API_HASH: apiHash}), {apiId: 123, apiHash});
  assert.throws(() => telegramCredentials({TELOPOTIFY_API_ID: '2147483648', TELOPOTIFY_API_HASH: apiHash}), /Configure/);
  assert.throws(() => telegramCredentials({TELOPOTIFY_API_ID: '0', TELOPOTIFY_API_HASH: 'sensitive-invalid-value'}),
    error => !error.message.includes('sensitive-invalid-value'));
});
