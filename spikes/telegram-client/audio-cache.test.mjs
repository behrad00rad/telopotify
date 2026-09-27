import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AudioRangeCache, cacheLimitFromEnv, DEFAULT_CACHE_BYTES } from './audio-cache.mjs';

test('cache serves a contained range and keeps the active song during eviction', () => {
  const cache = new AudioRangeCache(8);
  cache.put('old', 0, Buffer.from('abcd'));
  cache.put('current', 100, Buffer.from('efgh'));
  assert.equal(cache.get('current', 101, 2).toString(), 'fg');
  cache.put('current', 104, Buffer.from('ijkl'));
  assert.equal(cache.get('old', 0, 1), null);
  assert.equal(cache.get('current', 100, 4).toString(), 'efgh');
  assert.equal(cache.stats().bytes, 8);
  cache.deleteSong('current');
  assert.equal(cache.stats().bytes, 0);
  cache.clear();
  assert.deepEqual(cache.stats(), { bytes: 0, limitBytes: 8, chunks: 0 });
});

test('cache never keeps an oversized range and supports a disabled limit', () => {
  const cache = new AudioRangeCache(2);
  cache.put('song', 0, Buffer.from('abc'));
  assert.equal(cache.stats().bytes, 0);
  assert.equal(cacheLimitFromEnv(), DEFAULT_CACHE_BYTES);
  assert.equal(cacheLimitFromEnv('0'), 0);
  assert.equal(cacheLimitFromEnv('64'), 64 * 1024 * 1024);
  assert.throws(() => cacheLimitFromEnv('-1'), /TELOPOTIFY_CACHE_MB/);
  assert.throws(() => cacheLimitFromEnv('1.5'), /TELOPOTIFY_CACHE_MB/);
});
