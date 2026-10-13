import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BridgePool, bridgeLimits} from './bridge-pool.mjs';

test('idle bridges are stopped and restarted; active playback and limit reservations are protected', async () => {
  let now = 0; const starts = [], stops = [];
  const pool = new BridgePool(async id => {
    starts.push(id); return {address: id, stop: async () => stops.push(id)};
  }, {maxProcesses: 1, idleMs: 100, now: () => now});
  const playing = await pool.acquire('a');
  now = 1000; await pool.cleanup();
  assert.deepEqual(stops, []);
  await assert.rejects(pool.acquire('b'), error => error.status === 503);
  playing.release(); playing.release();
  now = 1099; await pool.cleanup(); assert.deepEqual(stops, []);
  now = 1100; const other = await pool.acquire('b');
  assert.deepEqual(stops, ['a']); assert.deepEqual(starts, ['a', 'b']);
  other.release(); now = 1200; await pool.cleanup();
  const restarted = await pool.acquire('a');
  assert.deepEqual(starts, ['a', 'b', 'a']);
  restarted.release(); await pool.close(); assert.equal(pool.entries.size, 0);
});
test('pending startups share one slot, failed startups release it, and stale exit callbacks are harmless', async () => {
  let resolveStart, exitOld, count = 0;
  const pool = new BridgePool((id, onExit) => {
    count++; exitOld ||= onExit;
    return new Promise(done => { resolveStart = () => done({address: id, stop: async () => {}}); });
  }, {maxProcesses: 1, idleMs: 1});
  const first = pool.acquire('a'); const second = pool.acquire('a');
  await assert.rejects(pool.acquire('b'), error => error.status === 503);
  resolveStart(); const leases = await Promise.all([first, second]);
  assert.equal(count, 1); leases.forEach(lease => lease.release());
  exitOld();
  const newer = pool.acquire('a'); await Promise.resolve(); resolveStart(); await newer;
  exitOld(); assert.equal(pool.entries.size, 1);
  await pool.close();
  let failures = 0;
  const failing = new BridgePool(async () => { failures++; throw new Error('start failed'); });
  await assert.rejects(failing.acquire('a'), /start failed/);
  await assert.rejects(failing.acquire('a'), /start failed/);
  assert.equal(failures, 2); assert.equal(failing.entries.size, 0); await failing.close();
});
test('bridge configuration rejects disabled or invalid limits', () => {
  assert.deepEqual(bridgeLimits({}), {maxProcesses: 8, idleMs: 900_000});
  assert.throws(() => bridgeLimits({TELOPOTIFY_MAX_BRIDGES: '0'}), /positive integer/);
  assert.throws(() => bridgeLimits({TELOPOTIFY_BRIDGE_IDLE_MINUTES: 'no'}), /positive integer/);
});

test('a failed stop does not free a still-running process slot', async () => {
  let now = 0, mayStop = false;
  const pool = new BridgePool(async id => ({address: id, stop: async () => {
    if (!mayStop) throw new Error('stop failed');
  }}), {maxProcesses: 1, idleMs: 1, now: () => now});
  const lease = await pool.acquire('a'); lease.release(); now = 2;
  await assert.rejects(pool.cleanup(), /stop failed/);
  assert.equal(pool.entries.size, 1);
  mayStop = true;
  const next = await pool.acquire('b'); assert.equal(next.address, 'b');
  next.release(); await pool.close();
});
