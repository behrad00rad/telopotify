import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseLibraryCache } from './library-cache.mjs';

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
