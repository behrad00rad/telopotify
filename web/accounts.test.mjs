import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {AccountStore} from './accounts.mjs';

async function withStore(work) {
  const dir = await mkdtemp(resolve(tmpdir(), 'telopotify-accounts-'));
  const path = resolve(dir, 'accounts.json');
  try { await work(new AccountStore(path), path); }
  finally { await rm(dir, {recursive: true, force: true}); }
}
test('recovery is hashed, single-use under concurrent requests, and survives restart', () => withStore(async (store, path) => {
  const account = await store.register('tester', 'original-password-123');
  assert.match(account.recoveryCode, /^(?:[A-F0-9]{8}-){5}[A-F0-9]{8}$/);
  assert.equal((await readFile(path, 'utf8')).includes(account.recoveryCode), false);
  const reopened = new AccountStore(path); await reopened.load();
  const results = await Promise.all([1, 2].map(() => reopened.recover('tester', account.recoveryCode, 'replacement-password-123')));
  const success = results.filter(Boolean);
  assert.equal(success.length, 1);
  assert.equal(success[0].id, account.id);
  assert.notEqual(success[0].recoveryCode, account.recoveryCode);
  assert.equal(await reopened.verify('tester', 'original-password-123'), null);
  assert.equal((await reopened.verify('tester', 'replacement-password-123')).sessionVersion, 1);
  assert.equal(await reopened.recover('tester', account.recoveryCode, 'another-password-123'), null);
  assert.equal(await reopened.recover('unknown', success[0].recoveryCode, 'another-password-123'), null);
  assert.equal((await readFile(path, 'utf8')).includes(success[0].recoveryCode), false);
  assert.ok(await reopened.recover('tester', success[0].recoveryCode.toLowerCase(), 'another-password-123'));
}));
test('password confirmation is required; legacy users can generate and replace recovery codes', () => withStore(async (store, path) => {
  const registered = await store.register('legacy_user', 'original-password-123');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.accounts[0].recoveryHash; delete saved.accounts[0].sessionVersion;
  await writeFile(path, JSON.stringify(saved)); await store.load();
  assert.equal((await store.verify('legacy_user', 'original-password-123')).sessionVersion, 0);
  assert.equal(await store.replaceRecovery(registered.id, 'wrong'), null);
  assert.equal(await store.changePassword(registered.id, 'wrong', 'new-password-123'), null);
  const first = await store.replaceRecovery(registered.id, 'original-password-123');
  const second = await store.replaceRecovery(registered.id, 'original-password-123');
  assert.equal(await store.recover('legacy_user', first.recoveryCode, 'new-password-123'), null);
  assert.equal((await store.changePassword(registered.id, 'original-password-123', 'new-password-123')).sessionVersion, 1);
  assert.ok(await store.recover('legacy_user', second.recoveryCode, 'newest-password-123'));
}));
test('failed persistence does not consume a recovery code or change the password', () => withStore(async store => {
  const account = await store.register('tester', 'original-password-123');
  const persist = store.persist.bind(store);
  store.persist = async () => { throw new Error('simulated disk failure'); };
  await assert.rejects(store.recover('tester', account.recoveryCode, 'new-password-123'), /disk failure/);
  assert.ok(await store.verify('tester', 'original-password-123'));
  store.persist = persist;
  assert.ok(await store.recover('tester', account.recoveryCode, 'new-password-123'));
}));
