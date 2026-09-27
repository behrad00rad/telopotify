export function parseLibraryCache(text) {
  const value = JSON.parse(text);
  if (!value || typeof value.channel !== 'string' || !Array.isArray(value.tracks) ||
      (value.lastSyncedMessageId !== undefined &&
        (!Number.isSafeInteger(value.lastSyncedMessageId) || value.lastSyncedMessageId < 0)) ||
      !value.tracks.every(track => Number.isSafeInteger(track.messageId) && track.messageId > 0 &&
        Number.isSafeInteger(track.fileSize) && track.fileSize > 0 &&
        typeof track.title === 'string' && typeof track.artist === 'string')) {
    throw new Error('Saved song catalog is invalid');
  }
  return { channel: value.channel,
    ...(typeof value.channelId === 'string' ? { channelId: value.channelId } : {}),
    ...(value.lastSyncedMessageId !== undefined ? { lastSyncedMessageId: value.lastSyncedMessageId } : {}),
    tracks: value.tracks };
}

export function mergeRecentTracks(existing, incoming, limit) {
  const byId = new Map(existing.map(track => [track.messageId, track]));
  for (const track of incoming) byId.set(track.messageId, track);
  return [...byId.values()].sort((a, b) => b.messageId - a.messageId).slice(0, limit);
}
