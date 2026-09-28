import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { archiveArtwork, imageMime, matchingRelease, telegramArtwork } from './artwork-source.mjs';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const release = '99b09d02-9cc9-3fed-8431-f162165a9371';

test('Telegram embedded thumbnail is used without fetching the full audio document', async () => {
  let downloadCount = 0;
  const thumb = { w: 500, h: 500, type: 'm' };
  const message = { media: { document: { thumbs: [thumb] } } };
  const client = { downloadMedia: async (_message, options) => {
    downloadCount++;
    assert.equal(options.thumb, thumb);
    return jpeg;
  }, invoke: () => { throw new Error('Should not ask Telegram for a fallback image'); } };
  assert.equal((await telegramArtwork(client, message)).source, 'telegram');
  assert.equal(downloadCount, 1);
  assert.equal(imageMime(jpeg), 'image/jpeg');
  assert.equal(imageMime(Buffer.from('not an image')), null);
});

test('Telegram album thumbnail request only retrieves image bytes', async () => {
  const calls = [];
  const client = { invoke: async (request, dcId) => {
    calls.push({ request, dcId });
    return calls.length === 1 ? { webfileDcId: 4 } : { size: jpeg.length, bytes: jpeg };
  } };
  const image = await telegramArtwork(client, { media: { document: {
    id: 123, accessHash: 456, fileReference: Buffer.from([1]), thumbs: [],
  } } });
  assert.equal(image.mime, 'image/jpeg');
  assert.equal(calls[1].request.className, 'upload.GetWebFile');
  assert.equal(calls[1].dcId, 4);
  assert.equal(calls[1].request.location.className, 'InputWebFileAudioAlbumThumbLocation');
});

test('external matches require the exact release and artist, and honor an album label', async () => {
  const catalog = { 'release-groups': [{ score: 100, id: release, title: 'Song',
    'artist-credit': [{ artist: { name: 'Artist' } }],
  }] };
  assert.equal(matchingRelease(catalog, { title: 'Song', artist: 'Artist' }), release);
  assert.equal(matchingRelease(catalog, { title: 'Song', artist: 'Artist' }, 'Album'), null);
  assert.equal(matchingRelease(catalog, { title: 'Song', artist: 'Another artist' }), null);
  const urls = [];
  const fetcher = async url => {
    urls.push(url);
    return urls.length === 1 ? Response.json(catalog) : new Response(jpeg, { status: 200,
      headers: { 'Content-Type': 'image/jpeg' } });
  };
  const image = await archiveArtwork({ title: 'Song', artist: 'Artist' }, '', fetcher);
  assert.equal(image.source, 'archive');
  assert.match(urls[0], /musicbrainz\.org/);
  assert.match(urls[1], /coverartarchive\.org/);
});
