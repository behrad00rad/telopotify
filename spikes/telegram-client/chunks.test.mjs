import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CHUNK_BYTES, readTelegramRange, fetchTelegramChunk } from './chunks.mjs';

test('aligns an arbitrary seek and yields exactly the requested bytes', async () => {
  const bytes = Buffer.alloc(CHUNK_BYTES * 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  let requested;
  const client = {
    async *iterDownload(_message, params) {
      requested = params;
      for (let offset = params.offset; offset < params.offset + params.limit; offset += params.requestSize) {
        yield bytes.subarray(offset, offset + params.requestSize);
      }
    },
  };

  const start = CHUNK_BYTES - 17;
  const length = 1000;
  const parts = [];
  for await (const part of readTelegramRange(client, {}, start, length)) parts.push(part);
  assert.equal(requested.offset, 0);
  assert.equal(requested.requestSize, CHUNK_BYTES);
  assert.deepEqual(Buffer.concat(parts), bytes.subarray(start, start + length));
});

test('retries a transient Telegram failure before returning a complete chunk', async () => {
  let attempts = 0;
  const client = {
    async *iterDownload() {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      yield Buffer.from('abcdefgh');
    },
  };
  const chunk = await fetchTelegramChunk(client, {}, 2, 4);
  assert.equal(chunk.toString(), 'cdef');
  assert.equal(attempts, 2);
});

test('rejects a short Telegram download instead of returning a partial HTTP body', async () => {
  const client = { async *iterDownload() { yield Buffer.from('ab'); } };
  await assert.rejects(fetchTelegramChunk(client, {}, 0, 4), /Incomplete Telegram chunk/);
});
