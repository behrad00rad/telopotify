import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseDesktopExport } from './desktopExport.ts';

test('imports only song metadata, including skipped media', () => {
  const tracks = parseDesktopExport({ messages: [
    { id: 7, type: 'message', media_type: 'audio_file', file: '(File not included)',
      file_name: 'song.mp3', file_size: 7654321, title: 'Song', performer: 'Artist',
      duration_seconds: 202, mime_type: 'audio/mpeg' },
    { id: 8, type: 'message', media_type: 'audio_file', file: '(File not included)',
      file_name: 'untitled.m4a' },
    { id: 9, type: 'message', media_type: 'video_file', file_name: 'movie.mp4' },
  ] });
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].title, 'Song');
  assert.equal(tracks[0].artist, 'Artist');
  assert.equal(tracks[0].fileSize, 7654321);
  assert.equal(tracks[1].title, 'untitled');
  assert.equal(tracks[1].fileSize, null);
});

test('rejects data that is not a chat export', () => {
  assert.throws(() => parseDesktopExport({}), /messages array/);
});
