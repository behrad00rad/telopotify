import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_LIMIT = 128 * 1024 * 1024;
const MISSING_FOR_MS = 7 * 24 * 60 * 60 * 1000;

function key(channelId, messageId) {
  if (!/^-?\d{1,20}$/.test(String(channelId)) || !/^\d{1,16}$/.test(String(messageId))) {
    throw new Error('Invalid artwork reference');
  }
  return `${channelId}_${messageId}`;
}

export class ArtworkStore {
  constructor(directory) {
    this.directory = directory;
    this.entries = {};
    this.inFlight = new Map();
    this.active = 0;
    this.waiting = [];
    this.epoch = 0;
    this.pendingSave = Promise.resolve();
  }

  pathFor(itemKey) { return join(this.directory, `${itemKey}.image`); }

  async load() {
    await mkdir(this.directory, { recursive: true });
    try {
      const data = JSON.parse(await readFile(join(this.directory, 'manifest.json'), 'utf8'));
      if (data?.version !== 1 || !data.entries || typeof data.entries !== 'object') return;
      for (const [itemKey, entry] of Object.entries(data.entries)) {
        if (!/^-?\d{1,20}_\d{1,16}$/.test(itemKey)) continue;
        if (entry?.missingAt && Number.isFinite(entry.missingAt)) this.entries[itemKey] = entry;
        else if (entry?.mime && ['image/jpeg', 'image/png'].includes(entry.mime) &&
            Number.isSafeInteger(entry.size) && entry.size > 0 &&
            (await stat(this.pathFor(itemKey)).catch(() => null))?.size === entry.size) {
          this.entries[itemKey] = entry;
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  save() {
    this.pendingSave = this.pendingSave.catch(() => {}).then(async () => {
      const temporary = join(this.directory, `manifest.${process.pid}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, entries: this.entries }),
          { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, join(this.directory, 'manifest.json'));
      } finally { await unlink(temporary).catch(() => {}); }
    });
    return this.pendingSave;
  }

  async cached(itemKey, hint) {
    const entry = this.entries[itemKey];
    if (!entry) return undefined;
    if ((entry.hint ?? '') !== hint) {
      delete this.entries[itemKey];
      await unlink(this.pathFor(itemKey)).catch(() => {});
      return undefined;
    }
    if (entry.missingAt) {
      if (Date.now() - entry.missingAt < MISSING_FOR_MS) return null;
      delete this.entries[itemKey];
      return undefined;
    }
    try {
      return { bytes: await readFile(this.pathFor(itemKey)), mime: entry.mime, source: entry.source };
    } catch { delete this.entries[itemKey]; return undefined; }
  }

  async resolve(channelId, track, telegram, external, hint = '') {
    const itemKey = key(channelId, track.messageId);
    const cached = await this.cached(itemKey, hint);
    if (cached !== undefined) return cached;
    if (this.inFlight.has(itemKey)) {
      const pending = this.inFlight.get(itemKey);
      if (pending.hint === hint) return pending.task;
      await pending.task.catch(() => {});
      return this.resolve(channelId, track, telegram, external, hint);
    }
    const epoch = this.epoch;
    const task = new Promise((resolve, reject) => {
      const start = async () => {
        this.active++;
        try { resolve(await this.fetchAndSave(itemKey, track, telegram, external, epoch, hint)); }
        catch (error) { reject(error); }
        finally {
          this.active--;
          this.inFlight.delete(itemKey);
          this.waiting.shift()?.();
        }
      };
      if (this.active < 2) start();
      else this.waiting.push(start);
    });
    this.inFlight.set(itemKey, { hint, task });
    return task;
  }

  async fetchAndSave(itemKey, track, telegram, external, epoch, hint) {
    let image = null;
    let failed = false;
    try { image = await telegram(track); } catch { failed = true; }
    if (!image) {
      try { image = await external(track); } catch { failed = true; }
    }
    if (epoch !== this.epoch) return null;
    if (!image) {
      if (!failed) { this.entries[itemKey] = { missingAt: Date.now(), hint }; await this.save(); }
      return null;
    }
    const temporary = `${this.pathFor(itemKey)}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, image.bytes, { mode: 0o600 });
      await rename(temporary, this.pathFor(itemKey));
      this.entries[itemKey] = { mime: image.mime, size: image.bytes.length,
        source: image.source, accessedAt: Date.now(), hint };
      await this.evict();
      await this.save();
      return image;
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async evict() {
    let total = Object.values(this.entries).reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (total <= CACHE_LIMIT) return;
    const oldest = Object.entries(this.entries).filter(([, entry]) => entry.size)
      .sort((a, b) => (a[1].accessedAt ?? 0) - (b[1].accessedAt ?? 0));
    for (const [itemKey, entry] of oldest) {
      if (total <= CACHE_LIMIT) break;
      delete this.entries[itemKey];
      total -= entry.size;
      await unlink(this.pathFor(itemKey)).catch(() => {});
    }
  }

  async clear() {
    this.epoch++;
    await Promise.allSettled([...this.inFlight.values()].map(item => item.task));
    this.entries = {};
    await this.pendingSave.catch(() => {});
    for (const name of await readdir(this.directory).catch(() => [])) {
      if (/^-?\d{1,20}_\d{1,16}\.image(?:\.\d+\.tmp)?$|^manifest\.\d+\.tmp$/.test(name) ||
          name === 'manifest.json') await unlink(join(this.directory, name)).catch(() => {});
    }
  }
}
