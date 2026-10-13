export function bridgeLimits(env = process.env) {
  const positive = (name, fallback) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  return {maxProcesses: positive('TELOPOTIFY_MAX_BRIDGES', 8),
    idleMs: positive('TELOPOTIFY_BRIDGE_IDLE_MINUTES', 15) * 60_000};
}

export class BridgePool {
  constructor(start, {maxProcesses = 8, idleMs = 15 * 60_000, now = Date.now} = {}) {
    this.start = start; this.maxProcesses = maxProcesses; this.idleMs = idleMs; this.now = now;
    this.entries = new Map(); this.closed = false;
  }
  async stop(id, entry) {
    if (entry.stopping) return entry.stopping;
    entry.stopping = (async () => {
      let bridge;
      try { bridge = await entry.ready; }
      catch { if (this.entries.get(id) === entry) this.entries.delete(id); return; }
      try {
        await bridge.stop();
        if (this.entries.get(id) === entry) this.entries.delete(id);
      } catch (error) {
        // A failed stop must not free a slot while its process may still be alive.
        entry.stopping = null;
        throw error;
      }
    })();
    return entry.stopping;
  }
  async cleanup() {
    await Promise.all([...this.entries].filter(([, entry]) => entry.active === 0 &&
      this.now() - entry.lastUsed >= this.idleMs).map(([id, entry]) => this.stop(id, entry)));
  }
  async acquire(id) {
    if (this.closed) throw Object.assign(new Error('Music service is shutting down'), {status: 503});
    let entry = this.entries.get(id);
    if (entry?.stopping) { await entry.stopping; return this.acquire(id); }
    if (!entry && this.entries.size >= this.maxProcesses) {
      await this.cleanup();
      if (this.closed) throw Object.assign(new Error('Music service is shutting down'), {status: 503});
      // Another request may have reserved this account while cleanup was running.
      entry = this.entries.get(id);
      if (entry?.stopping) { await entry.stopping; return this.acquire(id); }
      if (!entry && this.entries.size >= this.maxProcesses) {
        throw Object.assign(new Error('All music-service slots are in use. Try again shortly.'), {status: 503});
      }
    }
    if (!entry) {
      entry = {active: 0, lastUsed: this.now(), ready: null, stopping: null};
      this.entries.set(id, entry);
      entry.ready = Promise.resolve().then(() => this.start(id, () => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
      }));
      entry.ready.catch(() => { if (this.entries.get(id) === entry) this.entries.delete(id); });
    }
    entry.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; entry.active--; entry.lastUsed = this.now();
    };
    try {
      const bridge = await entry.ready;
      if (this.closed) throw Object.assign(new Error('Music service is shutting down'), {status: 503});
      return {address: bridge.address, release};
    } catch (error) { release(); throw error; }
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.entries].map(([id, entry]) => this.stop(id, entry)));
  }
}
