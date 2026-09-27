import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRange } from './range.mjs';

export function createRangeServer(filePath) {
  const file = resolve(filePath);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error('Path is not a file');
  const size = stat.size;

const mime = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
}[extname(file).toLowerCase()] ?? 'application/octet-stream';
const token = randomBytes(16).toString('hex');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Range playback spike</title><body><h1>Range playback spike</h1><audio controls preload="none" src="/audio/${token}"></audio><p>Play, then seek ahead before the song finishes loading. Watch the server log for requested byte ranges.</p></body></html>`;

  return createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html);
    return;
  }
  if (pathname !== `/audio/${token}`) {
    response.writeHead(404);
    response.end();
    return;
  }

  const range = parseRange(request.headers.range, size);
  if (!range) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}` });
    response.end();
    return;
  }

  const length = Math.max(0, range.end - range.start + 1);
  console.log(`${request.method} ${request.headers.range ?? '(full)'} -> ${range.start}-${range.end}`);
  response.writeHead(range.status, {
    'Accept-Ranges': 'bytes',
    'Content-Type': mime,
    'Content-Length': length,
    'Cache-Control': 'no-store',
    ...(range.status === 206 ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}),
  });
  if (request.method === 'HEAD' || length === 0) {
    response.end();
    return;
  }
  const stream = createReadStream(file, { start: range.start, end: range.end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('Usage: node spikes/range-stream/server.mjs <local-audio-file>');
    process.exit(1);
  }
  try {
    const server = createRangeServer(process.argv[2]);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      console.log(`Open http://127.0.0.1:${port}/`);
      console.log('Listening on localhost only. Press Ctrl+C to stop.');
    });
  } catch (error) {
    console.error(`Cannot read audio file: ${error.message}`);
    process.exit(1);
  }
}
