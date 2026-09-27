import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { createInterface } from 'node:readline/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseRange } from '../range-stream/range.mjs';
import { CHUNK_BYTES, readTelegramRange } from './chunks.mjs';

// Public TEST ONLY credentials from Telegram Desktop's source documentation.
// They are intentionally limited and must not be used in a distributed app.
const API_ID = 17349;
const API_HASH = '344583e45741c457fe1862106095a5eb';
const SESSION_PATH = resolve('local-data/telegram.session');

const rl = createInterface({ input: process.stdin, output: process.stdout });
let client;
let server;

async function ask(prompt) {
  return (await rl.question(prompt)).trim();
}

async function chooseChannel() {
  const dialogs = (await client.getDialogs({ limit: 100 })).filter(dialog => dialog.isChannel);
  if (!dialogs.length) throw new Error('No channels found in the first 100 dialogs');
  dialogs.forEach((dialog, index) => console.log(`${index + 1}. ${dialog.title ?? dialog.name ?? '(untitled)'}`));
  const selected = Number(await ask('Channel number: '));
  if (!Number.isInteger(selected) || selected < 1 || selected > dialogs.length) {
    throw new Error('Invalid channel selection');
  }
  return dialogs[selected - 1];
}

async function chooseAudio(dialog) {
  const messages = [];
  for await (const message of client.iterMessages(dialog.inputEntity, {
    filter: new Api.InputMessagesFilterMusic(), limit: 20,
  })) {
    if (message?.media?.document?.size) messages.push(message);
  }
  if (!messages.length) throw new Error('No audio messages found in the first 20 music results');
  messages.forEach((message, index) => {
    const file = message.media.document;
    const title = file.attributes?.find(attribute => attribute instanceof Api.DocumentAttributeAudio)?.title;
    console.log(`${index + 1}. ${title || `Message ${message.id}`} (${(Number(file.size) / 1_000_000).toFixed(1)} MB)`);
  });
  const selected = Number(await ask('Song number: '));
  if (!Number.isInteger(selected) || selected < 1 || selected > messages.length) {
    throw new Error('Invalid song selection');
  }
  return messages[selected - 1];
}

async function main() {
  let savedSession = '';
  try { savedSession = await readFile(SESSION_PATH, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  client = new TelegramClient(new StringSession(savedSession), API_ID, API_HASH, {
    connectionRetries: 3,
  });
  console.log('Telegram development login. Codes and passwords stay in this terminal.');
  await client.start({
    phoneNumber: () => ask('Phone number (international format): '),
    phoneCode: () => ask('Telegram login code: '),
    password: () => ask('Two-step password, if requested: '),
    emailAddress: () => ask('Login email, if requested: '),
    emailVerification: async () => ({ type: 'code', code: await ask('Email code: ') }),
    onError: error => console.error(`Login error: ${error.message}`),
  });
  await mkdir(resolve('local-data'), { recursive: true });
  await writeFile(SESSION_PATH, client.session.save(), { encoding: 'utf8', mode: 0o600 });

  const dialog = await chooseChannel();
  const message = await chooseAudio(dialog);
  const document = message.media.document;
  const size = Number(document.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Audio size is unavailable');
  const mime = document.mimeType || 'audio/mpeg';
  const token = randomBytes(16).toString('hex');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Telegram audio test</title><body><h1>Telegram audio test</h1><audio controls preload="none" src="/audio/${token}"></audio><p>Play and seek. The terminal logs requested byte ranges.</p></body></html>`;

  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(html);
      return;
    }
    if (path !== `/audio/${token}`) {
      response.writeHead(404);
      response.end();
      return;
    }
    const parsed = parseRange(request.headers.range, size);
    if (!parsed) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    const end = Math.min(parsed.end, parsed.start + CHUNK_BYTES - 1);
    const length = end - parsed.start + 1;
    console.log(`${request.method} ${request.headers.range ?? '(full)'} -> ${parsed.start}-${end}`);
    response.writeHead(206, {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${parsed.start}-${end}/${size}`,
      'Content-Length': length,
      'Content-Type': mime,
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') { response.end(); return; }
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    try {
      let written = 0;
      for await (const part of readTelegramRange(client, message, parsed.start, length, abort.signal)) {
        if (response.destroyed) break;
        if (!response.write(part)) await new Promise(resolve => response.once('drain', resolve));
        written += part.length;
      }
      if (!response.destroyed) response.end();
      console.log(`Sent ${written}/${length} bytes`);
    } catch (error) {
      if (!abort.signal.aborted) console.error(`Telegram download failed: ${error.message}`);
      response.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log(`Open http://127.0.0.1:${server.address().port}/`);
  console.log('Press Ctrl+C to stop.');
  rl.close();
}

try {
  await main();
} catch (error) {
  console.error(`Probe failed: ${error.message}`);
  process.exitCode = 1;
  rl.close();
  server?.close();
  await client?.disconnect();
}
