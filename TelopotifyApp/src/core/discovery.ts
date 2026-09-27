import type { Track } from './library';

export type DurationFilter = 'any' | 'short' | 'medium' | 'long';
export type SortOrder = 'newest' | 'title' | 'artist' | 'duration';

export function fileType(track: Track): string {
  const subtype = track.mimeType?.split('/')[1]?.toLowerCase() ?? '';
  return subtype === 'mpeg' ? 'MP3' : subtype === 'x-flac' || subtype === 'flac' ? 'FLAC' :
    subtype === 'mp4' || subtype === 'x-m4a' ? 'M4A' : subtype === 'ogg' ? 'OGG' :
    subtype ? subtype.toUpperCase() : 'Unknown';
}

export function discoverTracks(tracks: Track[], options: {
  artist: string; duration: DurationFilter; type: string; sort: SortOrder;
}): Track[] {
  return tracks.filter(track => (!options.artist.trim() ||
    track.artist.toLocaleLowerCase().includes(options.artist.trim().toLocaleLowerCase())) &&
    (options.type === 'All types' || fileType(track) === options.type) &&
    (options.duration === 'any' || (track.durationSeconds != null && (
      options.duration === 'short' ? track.durationSeconds < 180 :
      options.duration === 'medium' ? track.durationSeconds >= 180 && track.durationSeconds < 360 :
      track.durationSeconds >= 360
    )))).sort((a, b) => options.sort === 'newest' ? b.messageId - a.messageId :
    options.sort === 'duration' ? (a.durationSeconds ?? Infinity) - (b.durationSeconds ?? Infinity) :
    options.sort === 'artist' ? a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title) :
    a.title.localeCompare(b.title));
}
