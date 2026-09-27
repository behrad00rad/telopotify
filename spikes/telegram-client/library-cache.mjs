export function parseLibraryCache(text) {
  const value = JSON.parse(text);
  if (!value || typeof value.channel !== 'string' || !Array.isArray(value.tracks) ||
      !value.tracks.every(track => Number.isSafeInteger(track.messageId) && track.messageId > 0 &&
        Number.isSafeInteger(track.fileSize) && track.fileSize > 0 &&
        typeof track.title === 'string' && typeof track.artist === 'string')) {
    throw new Error('Saved song catalog is invalid');
  }
  return { channel: value.channel,
    ...(typeof value.channelId === 'string' ? { channelId: value.channelId } : {}),
    tracks: value.tracks };
}
