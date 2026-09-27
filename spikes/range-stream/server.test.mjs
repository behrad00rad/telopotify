import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRangeServer } from './server.mjs';

test('serves a selected byte range without sending the whole file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-range-'));
  const file = join(dir, 'sample.wav');
  const contents = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  await writeFile(file, contents);
  const server = createRangeServer(file);

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const html = await (await fetch(url)).text();
    const path = /src="(\/audio\/[a-f0-9]+)"/.exec(html)?.[1];
    assert.ok(path);

    const response = await fetch(new URL(path, url), { headers: { Range: 'bytes=10-19' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 10-19/${contents.length}`);
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'abcdefghij');

    const invalid = await fetch(new URL(path, url), { headers: { Range: 'bytes=100-' } });
    assert.equal(invalid.status, 416);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
