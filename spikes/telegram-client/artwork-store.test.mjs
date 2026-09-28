import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtworkStore } from './artwork-store.mjs';

test('artwork cache deduplicates requests, survives restart, and clears on sign-out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telopotify-artwork-'));
  try {
    const track = { messageId: 7 };
    const image = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mime: 'image/jpeg', source: 'telegram' };
    let calls = 0;
    const first = new ArtworkStore(directory);
    await first.load();
    const fetcher = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return image; };
    const [one, two] = await Promise.all([
      first.resolve('-100123', track, fetcher, () => null),
      first.resolve('-100123', track, fetcher, () => null),
    ]);
    assert.deepEqual(one, two);
    assert.equal(calls, 1);
    const restarted = new ArtworkStore(directory);
    await restarted.load();
    assert.equal((await restarted.resolve('-100123', track, () => { throw new Error('unexpected'); },
      () => null)).mime, 'image/jpeg');
    const second = await restarted.resolve('-100123', track, () => null,
      () => ({ ...image, source: 'archive' }), 'Edited album');
    assert.equal(second.source, 'archive');
    await restarted.clear();
    const empty = new ArtworkStore(directory);
    await empty.load();
    assert.equal(await empty.resolve('-100123', track, () => null, () => null), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
