import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectionsStore, emptyCollections, normalizeCollections } from './collections-store.mjs';

test('normalizes playlists, favorites, and a restorable queue', () => {
  const result = normalizeCollections({ favorites: ['7', '7', '8'], recentTrackIds: ['8', '7', '8'],
    albumOverrides: { 7: '  Night Drive  ' },
    coverOverrides: { 7: 'https://example.com/cover.jpg' },
    playlists: [{ id: 'mix-1', name: '  Road trip  ', trackIds: ['8', '7', '8'] }],
    queue: { trackIds: ['7', '8'], currentTrackId: '8', repeat: 'all' } });
  assert.deepEqual(result.favorites, ['7', '8']);
  assert.deepEqual(result.playlists[0], { id: 'mix-1', name: 'Road trip', trackIds: ['8', '7'] });
  assert.equal(result.queue.currentTrackId, '8');
  assert.deepEqual(result.recentTrackIds, ['8', '7']);
  assert.deepEqual(result.albumOverrides, { 7: 'Night Drive' });
  assert.deepEqual(result.coverOverrides, { 7: 'https://example.com/cover.jpg' });
  assert.throws(() => normalizeCollections({ ...result, coverOverrides: { 7: 'http://example.com/cover.jpg' } }),
    /Invalid cover URL/);
  assert.throws(() => normalizeCollections({ ...result, playlists: [{ id: 'bad', name: '', trackIds: [] }] }),
    /Invalid collections/);
});

test('saves collections per channel and restores them after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telopotify-collections-'));
  try {
    const path = join(directory, 'collections.json');
    const first = new CollectionsStore(path);
    await first.put('-100123', { ...emptyCollections(), favorites: ['7'] });
    await first.put('200', { ...emptyCollections(), favorites: ['8'] });
    const restored = new CollectionsStore(path);
    await restored.load();
    assert.deepEqual(restored.get('-100123').favorites, ['7']);
    assert.deepEqual(restored.get('200').favorites, ['8']);
    await restored.clear();
    const afterClear = new CollectionsStore(path);
    await afterClear.load();
    assert.deepEqual(afterClear.get('-100123'), emptyCollections());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
