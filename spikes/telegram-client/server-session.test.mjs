import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { encryptServerSession, decryptServerSession } from './session-store.mjs';

test('hosted Telegram sessions are encrypted and authenticated', () => {
  const key = randomBytes(32);
  const secret = 'private-telegram-session-value';
  const encrypted = encryptServerSession(secret, key);
  assert.match(encrypted, /^aesgcm:v1:/);
  assert.equal(encrypted.includes(secret), false);
  assert.equal(decryptServerSession(encrypted, key), secret);
  assert.throws(() => decryptServerSession(encrypted, randomBytes(32)));
  const damaged = encrypted.slice(0, -4) + 'AAAA';
  assert.throws(() => decryptServerSession(damaged, key));
});
