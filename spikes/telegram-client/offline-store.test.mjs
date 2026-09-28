import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfflineStore } from './offline-store.mjs';

async function waitForJob(store, channelId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = store.status(channelId).job;
    if (!job || job.error) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Offline download did not finish');
}

test('pins only chosen songs, restores them, serves a byte range, and enforces storage limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telopotify-offline-'));
  try {
    const store = new OfflineStore(directory);
    await store.load();
    await store.setLimit(8);
    await store.pin('-100', [{ messageId: 7, fileSize: 6 }], async (_, offset, length) =>
      Buffer.from('abcdef').subarray(offset, offset + length));
    assert.equal(await waitForJob(store, '-100'), null);
    assert.deepEqual(store.status('-100').pinnedIds, ['7']);
    assert.equal(store.bytes(), 6);
    const bytes = [];
    for await (const part of store.stream('-100', 7, 2, 4)) bytes.push(part);
    assert.equal(Buffer.concat(bytes).toString(), 'cde');
    await assert.rejects(store.pin('-100', [{ messageId: 8, fileSize: 3 }], async () => Buffer.alloc(3)),
      /limit/);
    const restored = new OfflineStore(directory);
    await restored.load();
    assert.deepEqual(restored.status('-100').pinnedIds, ['7']);
    await restored.unpin('-100', ['7']);
    assert.equal(restored.bytes(), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed downloads leave no pinned song and can be retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telopotify-offline-'));
  try {
    const store = new OfflineStore(directory);
    await store.load();
    await store.pin('-100', [{ messageId: 7, fileSize: 6 }], async () => Buffer.from('abc'));
    assert.match((await waitForJob(store, '-100')).error, /Incomplete/);
    assert.deepEqual(store.status('-100').pinnedIds, []);
    await store.pin('-100', [{ messageId: 7, fileSize: 6 }], async () => Buffer.from('abcdef'));
    assert.equal(await waitForJob(store, '-100'), null);
    await store.clear();
    assert.equal(store.bytes(), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
