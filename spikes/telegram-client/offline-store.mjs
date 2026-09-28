import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_LIMIT = 2 * 1024 * 1024 * 1024;
const DEFAULT_LIMIT = 512 * 1024 * 1024;

function key(channelId, messageId) {
  if (!/^-?\d{1,20}$/.test(String(channelId)) || !/^\d{1,16}$/.test(String(messageId))) {
    throw new Error('Invalid offline song');
  }
  return `${channelId}_${messageId}`;
}

export class OfflineStore {
  constructor(directory) {
    this.directory = directory;
    this.items = {};
    this.limitBytes = DEFAULT_LIMIT;
    this.job = null;
    this.jobTask = null;
    this.epoch = 0;
  }

  pathFor(channelId, messageId) { return join(this.directory, `${key(channelId, messageId)}.audio`); }
  get(channelId, messageId) { return this.items[key(channelId, messageId)] ?? null; }
  bytes() { return Object.values(this.items).reduce((sum, item) => sum + item.size, 0); }
  status(channelId) {
    return { limitBytes: this.limitBytes, bytes: this.bytes(),
      pinnedIds: Object.entries(this.items).filter(([, item]) => item.channelId === channelId)
        .map(([, item]) => String(item.messageId)),
      job: this.job && this.job.channelId === channelId ? { ...this.job } : null };
  }

  async load() {
    await mkdir(this.directory, { recursive: true });
    let saved;
    try { saved = JSON.parse(await readFile(join(this.directory, 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (saved.version !== 1 || !Number.isSafeInteger(saved.limitBytes) ||
        saved.limitBytes < 0 || saved.limitBytes > MAX_LIMIT || !saved.items ||
        typeof saved.items !== 'object') throw new Error('Invalid offline catalog');
    this.limitBytes = saved.limitBytes;
    for (const item of Object.values(saved.items)) {
      const itemKey = key(item.channelId, item.messageId);
      const info = await stat(this.pathFor(item.channelId, item.messageId)).catch(() => null);
      if (info?.size === item.size && Number.isSafeInteger(item.size) && item.size >= 0) {
        this.items[itemKey] = { channelId: item.channelId, messageId: item.messageId, size: item.size };
      }
    }
  }

  async save() {
    const temporary = join(this.directory, `manifest.${process.pid}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, limitBytes: this.limitBytes, items: this.items }),
        { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, join(this.directory, 'manifest.json'));
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async setLimit(bytes) {
    if (this.jobTask) throw new Error('Wait for the offline download to finish');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_LIMIT || bytes < this.bytes()) {
      throw new Error('Storage limit must be between used space and 2 GB');
    }
    this.limitBytes = bytes;
    await this.save();
  }

  async pin(channelId, tracks, fetchChunk) {
    if (this.jobTask) throw new Error('An offline download is already running');
    this.job = null;
    if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > 2000) throw new Error('Choose 1–2000 songs');
    const chosen = [...new Map(tracks.map(track => [key(channelId, track.messageId), track])).values()]
      .filter(track => !this.get(channelId, track.messageId));
    if (chosen.some(track => !Number.isSafeInteger(track.fileSize) || track.fileSize <= 0) ||
        this.bytes() + chosen.reduce((sum, track) => sum + track.fileSize, 0) > this.limitBytes) {
      throw new Error('Offline storage limit would be exceeded');
    }
    this.job = { channelId, total: chosen.length, completed: 0, currentId: null, error: '' };
    if (!chosen.length) { this.job = null; return this.status(channelId); }
    // Run after sending the HTTP response; the status endpoint reports progress.
    const epoch = this.epoch;
    this.jobTask = new Promise(resolve => setImmediate(resolve)).then(async () => {
      for (const track of chosen) {
        if (epoch !== this.epoch) break;
        const destination = this.pathFor(channelId, track.messageId);
        const temporary = `${destination}.${process.pid}.tmp`;
        this.job.currentId = String(track.messageId);
        try {
          const file = await open(temporary, 'w', 0o600);
          try {
            for (let offset = 0; offset < track.fileSize; offset += 512 * 1024) {
              if (epoch !== this.epoch) throw new Error('Offline download cancelled');
              const length = Math.min(512 * 1024, track.fileSize - offset);
              const chunk = await fetchChunk(track, offset, length);
              if (epoch !== this.epoch) throw new Error('Offline download cancelled');
              if (!Buffer.isBuffer(chunk) || chunk.length !== length) throw new Error('Incomplete offline song');
              let written = 0;
              while (written < chunk.length) {
                written += (await file.write(chunk, written, chunk.length - written, offset + written)).bytesWritten;
              }
            }
          } finally { await file.close(); }
          await rename(temporary, destination);
          this.items[key(channelId, track.messageId)] = {
            channelId, messageId: track.messageId, size: track.fileSize,
          };
          await this.save();
          this.job.completed++;
        } catch (error) {
          await unlink(temporary).catch(() => {});
          if (epoch === this.epoch) this.job.error = error.message;
          break;
        }
      }
      if (epoch === this.epoch) {
        this.job.currentId = null;
        if (!this.job.error) this.job = null;
      }
    }).finally(() => {
      this.jobTask = null;
    });
    return this.status(channelId);
  }

  async unpin(channelId, messageIds) {
    if (this.jobTask) throw new Error('Wait for the offline download to finish');
    if (!Array.isArray(messageIds) || messageIds.length > 200) throw new Error('Invalid offline songs');
    for (const id of messageIds) {
      const itemKey = key(channelId, id);
      if (this.items[itemKey]) {
        delete this.items[itemKey];
        await unlink(this.pathFor(channelId, id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    await this.save();
    return this.status(channelId);
  }

  async clear() {
    if (this.jobTask) {
      this.epoch++;
      await this.jobTask;
      this.job = null;
    }
    for (const item of Object.values(this.items)) {
      await unlink(this.pathFor(item.channelId, item.messageId)).catch(() => {});
    }
    this.items = {};
    await this.save();
  }

  stream(channelId, messageId, start, end) {
    if (!this.get(channelId, messageId)) throw new Error('Song is not pinned');
    return createReadStream(this.pathFor(channelId, messageId), { start, end });
  }
}
