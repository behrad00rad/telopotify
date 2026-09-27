import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession, removeSession, saveSession } from './session-store.mjs';

test('Windows saves and migrates Telegram sessions encrypted for the current user',
  { skip: process.platform !== 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telopotify-session-test-'));
    const path = join(directory, 'telegram.session');
    try {
      const sample = 'test-session-without-credentials';
      await saveSession(path, sample);
      const encrypted = await readFile(path, 'utf8');
      assert.match(encrypted, /^dpapi:v1:/);
      assert.ok(!encrypted.includes(sample));
      assert.equal(await readSession(path), sample);

      await writeFile(path, 'old-plaintext-session');
      assert.equal(await readSession(path), 'old-plaintext-session');
      assert.match(await readFile(path, 'utf8'), /^dpapi:v1:/);
      await removeSession(path);
      assert.equal(await readSession(path), '');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
