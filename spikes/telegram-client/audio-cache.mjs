export const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

export function cacheLimitFromEnv(value) {
  if (value == null || value === '') return DEFAULT_CACHE_BYTES;
  const megabytes = Number(value);
  if (!Number.isInteger(megabytes) || megabytes < 0 || megabytes > 256) {
    throw new Error('TELOPOTIFY_CACHE_MB must be an integer from 0 to 256');
  }
  return megabytes * 1024 * 1024;
}

export class AudioRangeCache {
  constructor(limitBytes = DEFAULT_CACHE_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new Error('Invalid cache limit');
    this.limitBytes = limitBytes;
    this.bytes = 0;
    this.entries = new Map();
  }

  get(songKey, start, length) {
    for (const [key, entry] of this.entries) {
      if (entry.songKey !== songKey || start < entry.start ||
          start + length > entry.start + entry.data.length) continue;
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.data.subarray(start - entry.start, start - entry.start + length);
    }
    return null;
  }

  put(songKey, start, data) {
    if (!Buffer.isBuffer(data) || !data.length || data.length > this.limitBytes) return;
    const key = `${songKey}:${start}:${data.length}`;
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.data.length; this.entries.delete(key); }
    this.entries.set(key, { songKey, start, data });
    this.bytes += data.length;
    while (this.bytes > this.limitBytes) {
      const victim = [...this.entries].find(([, entry]) => entry.songKey !== songKey)?.[0] ??
        this.entries.keys().next().value;
      const removed = this.entries.get(victim);
      this.entries.delete(victim);
      this.bytes -= removed.data.length;
    }
  }

  clear() { this.entries.clear(); this.bytes = 0; }

  deleteSong(songKey) {
    for (const [key, entry] of this.entries) {
      if (entry.songKey !== songKey) continue;
      this.entries.delete(key);
      this.bytes -= entry.data.length;
    }
  }

  stats() { return { bytes: this.bytes, limitBytes: this.limitBytes, chunks: this.entries.size }; }
}
