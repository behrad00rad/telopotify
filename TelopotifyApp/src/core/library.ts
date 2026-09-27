export type TelegramAudioRecord = {
  channelId: string;
  messageId: number;
  fileId: number;
  fileSize: number;
  title?: string;
  artist?: string;
  fileName?: string;
  durationSeconds?: number;
  mimeType?: string;
};

export type Track = {
  id: string;
  channelId: string;
  messageId: number;
  fileId: number;
  fileSize: number;
  title: string;
  artist: string;
  durationSeconds: number | null;
  mimeType: string | null;
};

const clean = (value?: string): string => (value ?? '').trim();

export function trackFromAudio(record: TelegramAudioRecord): Track {
  if (!record.channelId || !Number.isSafeInteger(record.messageId) || record.messageId <= 0) {
    throw new Error('Invalid channel or message reference');
  }
  if (!Number.isSafeInteger(record.fileId) || record.fileId <= 0 ||
      !Number.isSafeInteger(record.fileSize) || record.fileSize < 0) {
    throw new Error('Invalid audio file reference');
  }

  const fileName = clean(record.fileName);
  const fallbackTitle = fileName.replace(/\.[^.]+$/, '').trim();
  return {
    id: `${record.channelId}:${record.messageId}`,
    channelId: record.channelId,
    messageId: record.messageId,
    fileId: record.fileId,
    fileSize: record.fileSize,
    title: clean(record.title) || fallbackTitle || `Track ${record.messageId}`,
    artist: clean(record.artist) || 'Unknown artist',
    durationSeconds: Number.isFinite(record.durationSeconds) && record.durationSeconds! >= 0
      ? Math.floor(record.durationSeconds!) : null,
    mimeType: clean(record.mimeType) || null,
  };
}

export function mergeTracks(existing: Track[], incoming: Track[]): Track[] {
  const byId = new Map(existing.map(track => [track.id, track]));
  for (const track of incoming) byId.set(track.id, track);
  return [...byId.values()].sort((a, b) => b.messageId - a.messageId);
}

export function searchTracks(tracks: Track[], query: string): Track[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return tracks;
  return tracks.filter(track => `${track.title} ${track.artist}`.toLocaleLowerCase().includes(term));
}
