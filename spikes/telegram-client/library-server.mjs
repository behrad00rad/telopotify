import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseRange } from '../range-stream/range.mjs';
import { CHUNK_BYTES, fetchTelegramChunk } from './chunks.mjs';
import { mergeRecentTracks, parseLibraryCache } from './library-cache.mjs';
import { createAuthFlow } from './auth-flow.mjs';
import { readSession, removeSession, saveSession } from './session-store.mjs';
import { restoreDelay, shouldRetryRestore } from './restore-policy.mjs';

// Public test-only credentials from Telegram Desktop. Never ship these in an app.
const API_ID = 17349;
const API_HASH = '344583e45741c457fe1862106095a5eb';
const DATA_DIR = resolve('local-data');
const SESSION_PATH = resolve(DATA_DIR, 'telegram.session');
const CONNECTION_PATH = resolve(DATA_DIR, 'bridge-connection.json');
const LIBRARY_CACHE_PATH = resolve(DATA_DIR, 'bridge-library.json');
const MAX_MESSAGES = 2000;
const SYNC_BATCH = 100;
const SYNC_INTERVAL_MS = 60_000;
const BRIDGE_PORT = 43127;
const token = randomBytes(24).toString('hex');

let client = null;
let authFlow = null;
let authenticated = false;
let initializing = true;
let dialogs = null;
let selectedDialog = null;
let selectedChannelId = null;
let channel = '';
let tracks = [];
let messages = new Map();
let indexing = false;
let syncing = false;
let lastSyncedMessageId = 0;
let catalogRevision = 0;
let lastSyncedAt = null;
let syncError = '';
let reconnecting = false;
let restoreAttempts = 0;
let restoreTimer = null;
let restoreEpoch = 0;

function newClient(session = '') {
  return new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 3 });
}

function songFromMessage(message) {
  const document = message?.media?.document;
  if (!document || !Number.isSafeInteger(Number(document.size))) return null;
  const audio = document.attributes?.find(item => item instanceof Api.DocumentAttributeAudio);
  const fileName = document.attributes?.find(item => item instanceof Api.DocumentAttributeFilename)?.fileName;
  return {
    messageId: message.id,
    title: audio?.title?.trim() || fileName?.replace(/\.[^.]+$/, '') || `Track ${message.id}`,
    artist: audio?.performer?.trim() || 'Unknown artist',
    durationSeconds: audio?.duration ?? null,
    fileSize: Number(document.size),
    mimeType: document.mimeType || 'audio/mpeg',
  };
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function optionalFile(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function saveLibraryCache(nextChannel, nextChannelId, nextTracks, cursor) {
  const temporary = `${LIBRARY_CACHE_PATH}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ channel: nextChannel, channelId: nextChannelId,
      lastSyncedMessageId: cursor, tracks: nextTracks }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, LIBRARY_CACHE_PATH);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function bodyOf(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new Error('Expected JSON');
  }
  let text = '';
  for await (const part of request) {
    text += part;
    if (text.length > 4096) throw new Error('Request is too large');
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value;
}

async function channels() {
  if (!authenticated || !client) throw new Error('Sign in first');
  if (!dialogs) dialogs = (await client.getDialogs({ limit: 100 })).filter(item => item.isChannel);
  return dialogs;
}

async function selectChannel(index) {
  if (indexing || syncing) throw new Error('The channel library is busy');
  const choices = await channels();
  if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
    throw new Error('Select a channel from the list');
  }
  indexing = true;
  try {
    const dialog = choices[index];
    const nextTracks = [];
    const nextMessages = new Map();
    for await (const message of client.iterMessages(dialog.inputEntity, {
      filter: new Api.InputMessagesFilterMusic(), limit: MAX_MESSAGES,
    })) {
      const song = songFromMessage(message);
      if (song) {
        nextTracks.push(song);
        nextMessages.set(song.messageId, message);
      }
    }
    const nextChannel = dialog.title ?? dialog.name ?? 'Channel';
    const nextChannelId = String(dialog.id);
    const cursor = Math.max(0, ...nextTracks.map(track => track.messageId));
    await saveLibraryCache(nextChannel, nextChannelId, nextTracks, cursor);
    selectedDialog = dialog;
    selectedChannelId = nextChannelId;
    channel = nextChannel;
    tracks = nextTracks;
    messages = nextMessages;
    lastSyncedMessageId = cursor;
    catalogRevision++;
    lastSyncedAt = new Date().toISOString();
    syncError = '';
    console.log(`Indexed ${tracks.length} songs without downloading audio.`);
    return { channel, count: tracks.length };
  } finally { indexing = false; }
}

async function syncSelectedChannel() {
  if (!authenticated || !selectedDialog || !client) throw new Error('Select a channel first');
  if (indexing || syncing) return { added: 0, count: tracks.length, busy: true };
  syncing = true;
  const dialog = selectedDialog;
  const cursor = lastSyncedMessageId;
  let nextCursor = cursor;
  const incoming = [];
  const incomingMessages = new Map();
  try {
    for await (const message of client.iterMessages(dialog.inputEntity, {
      filter: new Api.InputMessagesFilterMusic(), minId: cursor, reverse: true, limit: SYNC_BATCH,
    })) {
      nextCursor = Math.max(nextCursor, message.id);
      const song = songFromMessage(message);
      if (song) {
        incoming.push(song);
        incomingMessages.set(song.messageId, message);
      }
    }
    if (selectedDialog !== dialog) return { added: 0, count: tracks.length, busy: false };
    const currentIds = new Set(tracks.map(track => track.messageId));
    const added = incoming.filter(song => !currentIds.has(song.messageId)).length;
    if (nextCursor !== cursor || incoming.length) {
      const nextTracks = mergeRecentTracks(tracks, incoming, MAX_MESSAGES);
      await saveLibraryCache(channel, selectedChannelId, nextTracks, nextCursor);
      tracks = nextTracks;
      lastSyncedMessageId = nextCursor;
      for (const [id, message] of incomingMessages) messages.set(id, message);
      if (incoming.length) catalogRevision++;
    }
    lastSyncedAt = new Date().toISOString();
    syncError = '';
    if (added) console.log(`Added ${added} new channel songs without re-indexing the history.`);
    return { added, count: tracks.length, busy: false };
  } catch (error) {
    syncError = error.message;
    throw error;
  } finally { syncing = false; }
}

async function restoreSavedSession() {
  const epoch = restoreEpoch;
  const session = await readSession(SESSION_PATH);
  if (epoch !== restoreEpoch) return;
  if (!session) { initializing = false; reconnecting = false; return; }
  const candidate = newClient(session);
  client = candidate;
  try {
    await candidate.connect();
    await candidate.getMe();
    if (epoch !== restoreEpoch) {
      await candidate.disconnect().catch(() => {});
      if (client === candidate) client = null;
      return;
    }
    authenticated = true;
    reconnecting = false;
    restoreAttempts = 0;
    console.log('Saved Telegram session restored.');
    if (selectedChannelId) {
      try {
        const choices = await channels();
        const index = choices.findIndex(item => String(item.id) === selectedChannelId);
        if (index >= 0) {
          selectedDialog = choices[index];
          await syncSelectedChannel();
        }
      } catch { console.warn('Could not refresh the saved channel. Choose it again in the app.'); }
    }
  } catch (error) {
    await candidate.disconnect().catch(() => {});
    if (epoch !== restoreEpoch) {
      if (client === candidate) client = null;
      return;
    }
    if (client === candidate) client = null;
    authenticated = false;
    if (!shouldRetryRestore(error)) {
      reconnecting = false;
      console.warn('Saved Telegram session needs renewal.');
    } else {
      reconnecting = true;
      const delay = restoreDelay(restoreAttempts++);
      console.warn(`Telegram is unavailable. Retrying in ${Math.round(delay / 1000)} seconds.`);
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        restoreSavedSession().catch(() => { reconnecting = false; console.warn('Could not read saved Telegram session.'); });
      }, delay);
    }
  } finally { initializing = false; }
}

async function restoreSession() {
  try {
    const cachedText = await optionalFile(LIBRARY_CACHE_PATH);
    if (cachedText) {
      const cached = parseLibraryCache(cachedText);
      channel = cached.channel;
      tracks = cached.tracks;
      selectedChannelId = cached.channelId ?? null;
      lastSyncedMessageId = cached.lastSyncedMessageId ??
        Math.max(0, ...cached.tracks.map(track => track.messageId));
      catalogRevision++;
    }
  } catch { console.warn('Saved catalog is unavailable.'); }
  await restoreSavedSession();
}

function status() {
  const flow = authFlow?.state();
  return {
    authenticated, online: Boolean(authenticated && selectedDialog),
    step: initializing || reconnecting ? 'connecting' : authenticated ? 'authorized' : flow?.step ?? 'phone',
    error: flow?.error ?? '', channel, trackCount: tracks.length,
    selected: Boolean(selectedDialog), indexing, syncing, catalogRevision,
    lastSyncedAt, syncError,
  };
}

async function logout() {
  restoreEpoch++;
  if (restoreTimer) clearTimeout(restoreTimer);
  restoreTimer = null;
  reconnecting = false;
  initializing = false;
  authFlow?.cancel();
  authFlow = null;
  const old = client;
  client = null;
  authenticated = false;
  selectedDialog = null;
  selectedChannelId = null;
  dialogs = null;
  channel = '';
  tracks = [];
  messages = new Map();
  lastSyncedMessageId = 0;
  catalogRevision++;
  lastSyncedAt = null;
  syncError = '';
  if (old) {
    if (old.connected) await old.logOut().catch(() => old.disconnect().catch(() => {}));
    else await old.disconnect().catch(() => {});
  }
  await Promise.all([
    removeSession(SESSION_PATH),
    unlink(LIBRARY_CACHE_PATH).catch(error => { if (error.code !== 'ENOENT') throw error; }),
  ]);
}

async function handle(request, response) {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    // The app discovers the current token on this loopback-only port. Browsers
    // cannot read it cross-origin because the bridge sends no CORS headers.
    if (url.pathname === '/bootstrap' && request.method === 'GET') {
      return json(response, 200, { address: `http://127.0.0.1:${BRIDGE_PORT}?token=${token}` });
    }
    if (url.searchParams.get('token') !== token) {
      return json(response, 401, { error: 'Invalid local access token' });
    }
    if (url.pathname === '/status' && request.method === 'GET') {
      return json(response, 200, status());
    }
    if (url.pathname === '/auth/start' && request.method === 'POST') {
      if (authenticated || initializing) return json(response, 409, { error: 'Sign-in is not available now' });
      restoreEpoch++;
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = null;
      reconnecting = false;
      const { phone } = await bodyOf(request);
      if (!authFlow) {
        client = newClient();
        authFlow = createAuthFlow(client, async () => {
          await saveSession(SESSION_PATH, client.session.save());
          authenticated = true;
        });
      }
      authFlow.begin(phone);
      return json(response, 202, status());
    }
    if (url.pathname === '/auth/input' && request.method === 'POST') {
      const { step, value } = await bodyOf(request);
      if (!authFlow) return json(response, 409, { error: 'Sign-in has not started' });
      authFlow.submit(step, value);
      return json(response, 202, status());
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      await logout();
      return json(response, 200, status());
    }
    if (url.pathname === '/channels' && request.method === 'GET') {
      const choices = await channels();
      return json(response, 200, { channels: choices.map((item, index) => ({
        index, title: item.title ?? item.name ?? 'Channel', selected: item === selectedDialog,
      })) });
    }
    if (url.pathname === '/channels/select' && request.method === 'POST') {
      const { index } = await bodyOf(request);
      return json(response, 200, await selectChannel(index));
    }
    if (url.pathname === '/library' && request.method === 'GET') {
      return json(response, 200, { channel, channelId: selectedChannelId, tracks,
        catalogRevision, online: Boolean(authenticated && selectedDialog) });
    }
    if (url.pathname === '/library/sync' && request.method === 'POST') {
      return json(response, 200, await syncSelectedChannel());
    }
    const match = /^\/audio\/(\d+)$/.exec(url.pathname);
    if (!match) return json(response, 404, { error: 'Not found' });
    if (!authenticated || !selectedDialog || !client) {
      return json(response, 503, { error: 'Sign in and select a channel to stream' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(response, 405, { error: 'Method not allowed' });
    }
    const id = Number(match[1]);
    const track = tracks.find(item => item.messageId === id);
    if (!track) return json(response, 404, { error: 'Song not found' });
    let message = messages.get(id);
    if (!message) {
      message = (await client.getMessages(selectedDialog.inputEntity, { ids: id }))[0];
      if (!message || !songFromMessage(message)) return json(response, 404, { error: 'Song is no longer available' });
      messages.set(id, message);
    }
    const parsed = parseRange(request.headers.range, track.fileSize);
    if (!parsed) {
      response.writeHead(416, { 'Content-Range': `bytes */${track.fileSize}` });
      return response.end();
    }
    const end = Math.min(parsed.end, parsed.start + CHUNK_BYTES - 1);
    const length = end - parsed.start + 1;
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${parsed.start}-${end}/${track.fileSize}`,
      'Content-Length': length,
      'Content-Type': track.mimeType,
      'Cache-Control': 'no-store',
    };
    if (request.method === 'HEAD') {
      response.writeHead(206, headers);
      return response.end();
    }
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    const chunk = await fetchTelegramChunk(client, message, parsed.start, length, abort.signal);
    if (response.destroyed) return;
    response.writeHead(206, headers);
    response.end(chunk);
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      const userError = error instanceof SyntaxError ? 'Invalid JSON' : error.message;
      const statusCode = /Sign in|not active|already|Select|JSON|large|phone number|requested/.test(userError) ? 400 : 502;
      json(response, statusCode, { error: userError });
    } else response.destroy();
    if (request.url?.startsWith('/audio/')) console.error(`Audio request failed: ${error.message}`);
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const server = createServer(handle);
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(BRIDGE_PORT, '127.0.0.1', done);
  });
  const address = `http://127.0.0.1:${server.address().port}?token=${token}`;
  await writeFile(CONNECTION_PATH, JSON.stringify({ address }), { encoding: 'utf8', mode: 0o600 });
  console.log(`Local bridge ready at http://127.0.0.1:${BRIDGE_PORT}. The app connects automatically.`);
  console.log('Keep this terminal running. Ctrl+C stops the bridge.');
  restoreSession().catch(() => { initializing = false; console.warn('Could not restore Telegram session.'); });
  const syncTimer = setInterval(() => {
    if (authenticated && selectedDialog && !indexing && !syncing) {
      syncSelectedChannel().catch(() => console.warn('Channel sync will retry later.'));
    }
  }, SYNC_INTERVAL_MS);
  process.on('SIGINT', async () => {
    clearInterval(syncTimer);
    server.close();
    await client?.disconnect().catch(() => {});
    await unlink(CONNECTION_PATH).catch(() => {});
    process.exit(0);
  });
}

main().catch(error => { console.error(`Library bridge failed: ${error.message}`); process.exitCode = 1; });
