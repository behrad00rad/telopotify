import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseRange } from './range.mjs';

test('open and bounded ranges', () => {
  assert.deepEqual(parseRange('bytes=10-', 100), { status: 206, start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=10-29', 100), { status: 206, start: 10, end: 29 });
  assert.deepEqual(parseRange('bytes=90-200', 100), { status: 206, start: 90, end: 99 });
});

test('suffix range', () => {
  assert.deepEqual(parseRange('bytes=-20', 100), { status: 206, start: 80, end: 99 });
  assert.deepEqual(parseRange('bytes=-200', 100), { status: 206, start: 0, end: 99 });
});

test('invalid ranges are rejected', () => {
  for (const value of ['bytes=100-', 'bytes=20-10', 'bytes=0-1,3-4', 'bytes=-0', 'items=0-1']) {
    assert.equal(parseRange(value, 100), null);
  }
  assert.equal(parseRange('bytes=0-', 0), null);
});
