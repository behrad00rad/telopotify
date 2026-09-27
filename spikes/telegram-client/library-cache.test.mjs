import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mergeRecentTracks, parseLibraryCache } from './library-cache.mjs';

test('loads song metadata without needing audio bytes', () => {
  const catalog = { channel: 'Music', tracks: [{ messageId: 42, fileSize: 1000,
    title: 'Song', artist: 'Artist', mimeType: 'audio/mpeg' }] };
  assert.deepEqual(parseLibraryCache(JSON.stringify(catalog)), catalog);
});

test('rejects a malformed saved catalog', () => {
  assert.throws(() => parseLibraryCache('{"channel":"Music","tracks":[{"messageId":1}]}'),
    /invalid/);
});

test('keeps the selected channel identifier for session restore', () => {
  const catalog = { channel: 'Music', channelId: '123456789', tracks: [{
    messageId: 42, fileSize: 1000, title: 'Song', artist: 'Artist',
  }] };
  assert.deepEqual(parseLibraryCache(JSON.stringify(catalog)), catalog);
});

test('stores the sync cursor and merges new songs in descending order without duplicates', () => {
  const original = { channel: 'Music', channelId: '123', lastSyncedMessageId: 42,
    tracks: [{ messageId: 42, fileSize: 100, title: 'Old', artist: 'Artist' }] };
  assert.deepEqual(parseLibraryCache(JSON.stringify(original)), original);
  const tracks = mergeRecentTracks(original.tracks, [
    { messageId: 44, title: 'Newest' }, { messageId: 43, title: 'New' },
    { messageId: 42, title: 'Updated' },
  ], 3);
  assert.deepEqual(tracks.map(track => track.messageId), [44, 43, 42]);
  assert.equal(tracks[2].title, 'Updated');
});
