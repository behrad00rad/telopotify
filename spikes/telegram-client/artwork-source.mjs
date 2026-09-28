import { Api } from 'teleproto';

const MAX_IMAGE_BYTES = 3 * 512 * 1024;
const USER_AGENT = 'Telopotify/0.1 (https://github.com/behrad00rad/telopotify)';
let nextMusicBrainzRequest = 0;

export function imageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  return null;
}

function usableImage(bytes, source) {
  const mime = imageMime(bytes);
  return mime ? { bytes, mime, source } : null;
}

export async function telegramArtwork(client, message) {
  const document = message?.media?.document;
  if (!document) return null;
  const thumbs = (document.thumbs ?? []).filter(thumb => thumb.w && thumb.h);
  const thumb = thumbs.sort((a, b) => Math.abs(a.w - 600) - Math.abs(b.w - 600))[0];
  if (thumb) {
    try {
      const bytes = await client.downloadMedia(message, { thumb });
      const image = usableImage(bytes, 'telegram');
      if (image) return image;
    } catch { /* Try Telegram's album thumbnail service below. */ }
  }
  const config = await client.invoke(new Api.help.GetConfig());
  const location = new Api.InputWebFileAudioAlbumThumbLocation({
    document: new Api.InputDocument({ id: document.id, accessHash: document.accessHash,
      fileReference: document.fileReference }),
  });
  const parts = [];
  let length = 0;
  let expectedSize = 0;
  try {
    while (length < MAX_IMAGE_BYTES) {
      const file = await client.invoke(new Api.upload.GetWebFile({
        location, offset: length, limit: Math.min(512 * 1024, MAX_IMAGE_BYTES - length),
      }), config.webfileDcId);
      const part = Buffer.from(file.bytes ?? []);
      expectedSize = Number(file.size);
      if (expectedSize > MAX_IMAGE_BYTES) return null;
      if (!part.length) break;
      parts.push(part);
      length += part.length;
      if (length >= expectedSize) break;
    }
  } catch (error) {
    if (/LOCATION_INVALID|WEBFILE_NOT_FOUND|DOCUMENT_INVALID|FILE_ID_INVALID/.test(error.message)) return null;
    throw error;
  }
  if (expectedSize && length < expectedSize) return null;
  return usableImage(Buffer.concat(parts), 'telegram');
}

function normalized(value) {
  return String(value ?? '').toLocaleLowerCase().normalize('NFKD')
    .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function matchingRelease(result, track, album = '') {
  if (!result || !Array.isArray(result['release-groups'])) return null;
  const title = normalized(album || track.title);
  const artist = normalized(track.artist);
  for (const group of result['release-groups']) {
    if (Number(group.score) < 90 || normalized(group.title) !== title) continue;
    const credited = normalized((group['artist-credit'] ?? [])
      .map(item => item?.artist?.name ?? item?.name ?? '').join(' '));
    if (!credited || credited !== artist) continue;
    if (/^[0-9a-f-]{36}$/i.test(group.id ?? '')) return group.id;
  }
  return null;
}

async function musicBrainzJson(url, fetcher) {
  const wait = Math.max(0, nextMusicBrainzRequest - Date.now());
  nextMusicBrainzRequest = Date.now() + wait + 1100;
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  const response = await fetcher(url, { headers: { 'User-Agent': USER_AGENT,
    Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`MusicBrainz returned ${response.status}`);
  return response.json();
}

export async function archiveArtwork(track, album = '', fetcher = fetch) {
  if (!track?.title || !track?.artist || track.artist === 'Unknown artist') return null;
  const title = (album || track.title).replaceAll('"', '');
  const query = `release:"${title}" AND artist:"${track.artist.replaceAll('"', '')}"`;
  const url = `https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
  const release = matchingRelease(await musicBrainzJson(url, fetcher), track, album);
  if (!release) return null;
  const response = await fetcher(`https://coverartarchive.org/release-group/${release}/front-500`, {
    headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cover Art Archive returned ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) { await reader.cancel(); return null; }
    parts.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(parts);
  return usableImage(bytes, 'archive');
}
