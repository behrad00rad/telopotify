import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

export function emptyCollections() {
  return { favorites: [], playlists: [], recentTrackIds: [],
    queue: { trackIds: [], currentTrackId: null, repeat: 'off' } };
}

function ids(value) {
  if (!Array.isArray(value)) throw new Error('Invalid collections');
  const result = [];
  for (const id of value) {
    if (typeof id !== 'string' || !/^\d{1,16}$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error('Invalid collections');
    }
    if (!result.includes(id)) result.push(id);
  }
  if (result.length > 2000) throw new Error('Invalid collections');
  return result;
}

export function normalizeCollections(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid collections');
  const favorites = ids(value.favorites);
  if (!Array.isArray(value.playlists) || value.playlists.length > 50) throw new Error('Invalid collections');
  const playlistIds = new Set();
  const playlists = value.playlists.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || playlistIds.has(item.id) ||
        typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 60) {
      throw new Error('Invalid collections');
    }
    playlistIds.add(item.id);
    return { id: item.id, name: item.name.trim(), trackIds: ids(item.trackIds) };
  });
  const queue = value.queue;
  if (!queue || typeof queue !== 'object' || !['off', 'all', 'one'].includes(queue.repeat)) {
    throw new Error('Invalid collections');
  }
  const trackIds = ids(queue.trackIds);
  const currentTrackId = trackIds.includes(queue.currentTrackId) ? queue.currentTrackId : trackIds[0] ?? null;
  const recentTrackIds = ids(value.recentTrackIds ?? []).slice(0, 50);
  return { favorites, playlists, recentTrackIds,
    queue: { trackIds, currentTrackId, repeat: queue.repeat } };
}

export class CollectionsStore {
  constructor(path) { this.path = path; this.channels = {}; this.pending = Promise.resolve(); }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data?.version !== 1 || !data.channels || typeof data.channels !== 'object') {
        throw new Error('Invalid saved collections');
      }
      const channels = {};
      for (const [id, value] of Object.entries(data.channels)) {
        if (!/^-?\d{1,20}$/.test(id)) throw new Error('Invalid saved collections');
        channels[id] = normalizeCollections(value);
      }
      this.channels = channels;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  get(channelId) { return this.channels[channelId] ?? emptyCollections(); }

  async put(channelId, value) {
    if (typeof channelId !== 'string' || !/^-?\d{1,20}$/.test(channelId)) throw new Error('Invalid channel');
    const normalized = normalizeCollections(value);
    this.channels[channelId] = normalized;
    this.pending = this.pending.catch(() => {}).then(async () => {
      const temporary = `${this.path}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, channels: this.channels }),
          { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    });
    await this.pending;
    return normalized;
  }

  async clear() {
    await this.pending.catch(() => {});
    this.channels = {};
    await unlink(this.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
