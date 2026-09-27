import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { trackFromAudio, mergeTracks, searchTracks } from './library.ts';
import { addToQueue, advanceAfterEnd, createQueue, currentTrackId, moveQueueTrack, nextTrack,
  moveQueueTrackTo, playNextInQueue, previousTrack, removeFromQueue, shuffleUpcoming } from './queue.ts';
import { discoverTracks, fileType } from './discovery.ts';
import { trackFromTdMessage } from './tdlibMessages.ts';

test('normalizes incomplete Telegram metadata and merges a repeated message', () => {
  const first = trackFromAudio({ channelId: 'channel-1', messageId: 8, fileId: 3, fileSize: 99, fileName: 'A Song.mp3' });
  assert.equal(first.title, 'A Song');
  assert.equal(first.artist, 'Unknown artist');
  const updated = trackFromAudio({ channelId: 'channel-1', messageId: 8, fileId: 4, fileSize: 99, title: 'Better Title', artist: 'An Artist' });
  assert.deepEqual(mergeTracks([first], [updated]), [updated]);
  assert.deepEqual(searchTracks([updated], 'artist'), [updated]);
});

test('queue navigation handles the end and repeat modes', () => {
  const queue = createQueue(['a', 'b', 'b'], 'b');
  assert.deepEqual(queue.trackIds, ['a', 'b']);
  assert.equal(currentTrackId(nextTrack(queue)), 'b');
  assert.equal(currentTrackId(nextTrack({ ...queue, repeat: 'all' })), 'a');
  assert.equal(currentTrackId(previousTrack({ ...queue, currentIndex: 0, repeat: 'all' })), 'b');
  assert.equal(currentTrackId(nextTrack({ ...queue, repeat: 'one' }, true)), 'b');
});

test('completion advances, repeats, or stops at the end of the queue', () => {
  const first = createQueue(['a', 'b']);
  assert.equal(currentTrackId(advanceAfterEnd(first)), 'b');
  const last = { ...first, currentIndex: 1 };
  assert.equal(advanceAfterEnd(last), null);
  assert.equal(currentTrackId(advanceAfterEnd({ ...last, repeat: 'all' })), 'a');
  assert.equal(currentTrackId(advanceAfterEnd({ ...last, repeat: 'one' })), 'b');
});

test('removing the current track advances to the next available item', () => {
  const queue = createQueue(['a', 'b', 'c'], 'b');
  const changed = removeFromQueue(queue, 'b');
  assert.equal(currentTrackId(changed), 'c');
  assert.equal(currentTrackId(removeFromQueue(changed, 'c')), 'a');
});

test('queue editing preserves the selected song while moving and adding tracks', () => {
  const queue = createQueue(['a', 'b', 'c'], 'b');
  const moved = moveQueueTrack(queue, 'b', 1);
  assert.deepEqual(moved.trackIds, ['a', 'c', 'b']);
  assert.equal(currentTrackId(moved), 'b');
  assert.deepEqual(addToQueue(moved, 'd').trackIds, ['a', 'c', 'b', 'd']);
  assert.equal(addToQueue(moved, 'b'), moved);
  const next = playNextInQueue(queue, 'c');
  assert.deepEqual(next.trackIds, ['a', 'b', 'c']);
  assert.deepEqual(playNextInQueue(next, 'a').trackIds, ['b', 'a', 'c']);
  assert.equal(currentTrackId(playNextInQueue(next, 'a')), 'b');
});

test('drag and shuffle keep the current song and shuffle only upcoming songs', () => {
  const queue = createQueue(['a', 'b', 'c', 'd'], 'b');
  const shuffled = shuffleUpcoming(queue, () => 0);
  assert.deepEqual(shuffled.trackIds, ['a', 'b', 'd', 'c']);
  assert.equal(currentTrackId(shuffled), 'b');
  const moved = moveQueueTrackTo(shuffled, 'd', 0);
  assert.deepEqual(moved.trackIds, ['d', 'a', 'b', 'c']);
  assert.equal(currentTrackId(moved), 'b');
});

test('discovery combines artist, duration, type, and sort', () => {
  const tracks = [
    { id: '1', artist: 'A', title: 'Z', durationSeconds: 120, mimeType: 'audio/mpeg', messageId: 1 },
    { id: '2', artist: 'B', title: 'B', durationSeconds: 400, mimeType: 'audio/flac', messageId: 2 },
    { id: '3', artist: 'A', title: 'A', durationSeconds: 240, mimeType: 'audio/mpeg', messageId: 3 },
  ];
  assert.equal(fileType(tracks[0]), 'MP3');
  assert.deepEqual(discoverTracks(tracks, { artist: 'a', duration: 'medium', type: 'MP3', sort: 'title' })
    .map(track => track.id), ['3']);
  assert.deepEqual(discoverTracks(tracks, { artist: '', duration: 'any', type: 'All types', sort: 'newest' })
    .map(track => track.id), ['3', '2', '1']);
});

test('maps TDLib audio and audio document messages without fetching media', () => {
  const audio = trackFromTdMessage({
    id: 10, chat_id: -100123, content: {
      '@type': 'messageAudio',
      audio: { title: 'Hello', performer: 'Singer', duration: 123, audio: { id: 4, size: 2000 } },
    },
  });
  assert.equal(audio?.id, '-100123:10');
  assert.equal(audio?.title, 'Hello');
  assert.equal(audio?.fileSize, 2000);

  const document = trackFromTdMessage({
    id: 11, chat_id: -100123, content: {
      '@type': 'messageDocument',
      document: { file_name: 'Demo.FLAC', mime_type: 'application/octet-stream', document: { id: 5, size: 3000 } },
    },
  });
  assert.equal(document?.title, 'Demo');
  assert.equal(trackFromTdMessage({
    id: 12, chat_id: -100123, content: {
      '@type': 'messageDocument',
      document: { file_name: 'notes.pdf', mime_type: 'application/pdf', document: { id: 6, size: 3000 } },
    },
  }), null);
});
