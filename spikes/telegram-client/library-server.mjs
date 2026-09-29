import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseRange } from '../range-stream/range.mjs';
import { CHUNK_BYTES, fetchTelegramChunk, isStaleFileReference } from './chunks.mjs';
import { AudioRangeCache, cacheLimitFromEnv } from './audio-cache.mjs';
import { CollectionsStore } from './collections-store.mjs';
import { OfflineStore } from './offline-store.mjs';
import { ArtworkStore } from './artwork-store.mjs';
import { archiveArtwork, telegramArtwork } from './artwork-source.mjs';
import { mergeRecentTracks, parseLibraryCache } from './library-cache.mjs';
import { createAuthFlow } from './auth-flow.mjs';
import { readSession, removeSession, saveSession } from './session-store.mjs';
import { restoreDelay, shouldRetryRestore } from './restore-policy.mjs';

// Public test-only credentials from Telegram Desktop. Never ship these in an app.
const API_ID = Number(process.env.TELOPOTIFY_API_ID || 17349);
const API_HASH = process.env.TELOPOTIFY_API_HASH || '344583e45741c457fe1862106095a5eb';
const DATA_DIR = resolve(process.env.TELOPOTIFY_DATA_DIR || 'local-data');
const SESSION_PATH = resolve(DATA_DIR, 'telegram.session');
const CONNECTION_PATH = resolve(DATA_DIR, 'bridge-connection.json');
const LIBRARY_CACHE_PATH = resolve(DATA_DIR, 'bridge-library.json');
const COLLECTIONS_PATH = resolve(DATA_DIR, 'collections.json');
const OFFLINE_DIR = resolve(DATA_DIR, 'offline');
const ARTWORK_DIR = resolve(DATA_DIR, 'artwork');
const WEB_FILES = new Map([
  ['/web', [resolve('web/index.html'), 'text/html; charset=utf-8']],
  ['/web/', [resolve('web/index.html'), 'text/html; charset=utf-8']],
  ['/web/app.js', [resolve('web/app.js'), 'text/javascript; charset=utf-8']],
  ['/web/styles.css', [resolve('web/styles.css'), 'text/css; charset=utf-8']],
  ['/web/logo.png', [resolve('TelopotifyApp/assets/telopotify-logo.png'), 'image/png']],
]);
const MAX_MESSAGES = 2000;
const SYNC_BATCH = 100;
const SYNC_INTERVAL_MS = 60_000;
const BRIDGE_PORT = Number(process.env.TELOPOTIFY_BRIDGE_PORT ?? 43127);
const token = randomBytes(24).toString('hex');
const audioCache = new AudioRangeCache(cacheLimitFromEnv(process.env.TELOPOTIFY_CACHE_MB));
const collectionsStore = new CollectionsStore(COLLECTIONS_PATH);
const offlineStore = new OfflineStore(OFFLINE_DIR);
const artworkStore = new ArtworkStore(ARTWORK_DIR);

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
let unavailable = new Set();
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
let reconnectTask = null;
let healthFailures = 0;
let healthChecking = false;

async function withTimeout(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Telegram request timed out')), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

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

async function bodyOf(request, maxLength = 4096) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new Error('Expected JSON');
  }
  let text = '';
  for await (const part of request) {
    text += part;
    if (text.length > maxLength) throw new Error('Request is too large');
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
    unavailable = new Set();
    audioCache.clear();
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
      for (const id of incomingMessages.keys()) unavailable.delete(id);
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
    await withTimeout(candidate.connect(), 20_000);
    await withTimeout(candidate.getMe(), 20_000);
    if (epoch !== restoreEpoch) {
      await withTimeout(candidate.disconnect(), 5000).catch(() => {});
      if (client === candidate) client = null;
      return;
    }
    let choices = null;
    if (selectedChannelId) {
      choices = (await withTimeout(candidate.getDialogs({ limit: 100 }), 20_000))
        .filter(item => item.isChannel);
      if (epoch !== restoreEpoch) {
        await withTimeout(candidate.disconnect(), 5000).catch(() => {});
        if (client === candidate) client = null;
        return;
      }
      const index = choices.findIndex(item => String(item.id) === selectedChannelId);
      if (index >= 0) {
        selectedDialog = choices[index];
      } else console.warn('Saved channel is no longer accessible. Choose another channel in the app.');
    }
    dialogs = choices;
    authenticated = true;
    reconnecting = false;
    healthFailures = 0;
    restoreAttempts = 0;
    console.log('Saved Telegram session restored.');
    if (selectedDialog) syncSelectedChannel().catch(() => console.warn('Channel sync will retry later.'));
  } catch (error) {
    await withTimeout(candidate.disconnect(), 5000).catch(() => {});
    if (epoch !== restoreEpoch) {
      if (client === candidate) client = null;
      return;
    }
    if (client === candidate) client = null;
    authenticated = false;
    selectedDialog = null;
    dialogs = null;
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

async function reconnectSavedSession() {
  if (reconnectTask) return;
  healthFailures = 0;
  reconnecting = true;
  restoreEpoch++;
  if (restoreTimer) clearTimeout(restoreTimer);
  restoreTimer = null;
  restoreAttempts = 0;
  const old = client;
  client = null;
  authenticated = false;
  selectedDialog = null;
  dialogs = null;
  reconnectTask = (async () => {
    if (old) await withTimeout(old.disconnect(), 5000).catch(() => {});
    await restoreSavedSession();
  })().catch(() => {
    reconnecting = false;
    console.warn('Could not reconnect the saved Telegram session.');
  }).finally(() => { reconnectTask = null; });
}

function isTelegramOnline() {
  return Boolean(authenticated && selectedDialog && client?.connected && !reconnecting && !healthFailures);
}

function status() {
  const flow = authFlow?.state();
  return {
    authenticated, online: isTelegramOnline(),
    step: initializing || reconnecting ? 'connecting' : authenticated ? 'authorized' : flow?.step ?? 'phone',
    error: flow?.error ?? '', errorCode: flow?.diagnostic ?? '',
    authInProgress: Boolean(authFlow), channel, trackCount: tracks.length,
    selected: Boolean(selectedDialog), indexing, syncing, catalogRevision,
    lastSyncedAt, syncError, cache: audioCache.stats(), offline: selectedChannelId ?
      offlineStore.status(selectedChannelId) : null, unavailableTrackIds: [...unavailable],
  };
}

function markUnavailable(id) {
  unavailable.add(id);
  messages.delete(id);
  audioCache.deleteSong(`${selectedChannelId}:${id}`);
}

async function logout() {
  restoreEpoch++;
  if (restoreTimer) clearTimeout(restoreTimer);
  restoreTimer = null;
  reconnecting = false;
  healthFailures = 0;
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
  unavailable = new Set();
  audioCache.clear();
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
    collectionsStore.clear(),
    offlineStore.clear(),
    artworkStore.clear(),
  ]);
}

async function handle(request, response) {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const asset = WEB_FILES.get(url.pathname);
    if (asset && request.method === 'GET') {
      const bytes = await readFile(asset[0]);
      response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': bytes.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'" });
      return response.end(bytes);
    }
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
    if (url.pathname === '/reconnect' && request.method === 'POST') {
      if (authFlow && !authenticated) return json(response, 409, { error: 'Finish sign-in first' });
      reconnectSavedSession();
      return json(response, 202, status());
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
          authFlow = null;
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
    if (url.pathname === '/auth/cancel' && request.method === 'POST') {
      authFlow?.cancel();
      authFlow = null;
      const pendingClient = authenticated ? null : client;
      if (pendingClient) client = null;
      if (pendingClient) await withTimeout(pendingClient.disconnect(), 5000).catch(() => {});
      return json(response, 200, status());
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
        catalogRevision, online: isTelegramOnline(),
        unavailableTrackIds: [...unavailable] });
    }
    if (url.pathname === '/library/sync' && request.method === 'POST') {
      return json(response, 200, await syncSelectedChannel());
    }
    if (url.pathname === '/cache' && request.method === 'GET') {
      return json(response, 200, audioCache.stats());
    }
    if (url.pathname === '/cache/clear' && request.method === 'POST') {
      await bodyOf(request);
      audioCache.clear();
      return json(response, 200, audioCache.stats());
    }
    if (url.pathname === '/offline' && request.method === 'GET') {
      if (!selectedChannelId) return json(response, 409, { error: 'Choose a channel first' });
      return json(response, 200, offlineStore.status(selectedChannelId));
    }
    if (url.pathname === '/offline/limit' && request.method === 'POST') {
      const { limitBytes } = await bodyOf(request);
      await offlineStore.setLimit(limitBytes);
      return json(response, 200, offlineStore.status(selectedChannelId));
    }
    if (url.pathname === '/offline/pin' && request.method === 'POST') {
      if (!authenticated || !selectedDialog || !client || !selectedChannelId) {
        return json(response, 409, { error: 'Connect to Telegram before saving songs' });
      }
      const { trackIds } = await bodyOf(request);
      if (!Array.isArray(trackIds) || trackIds.length < 1 || trackIds.length > 2000 ||
          trackIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
        return json(response, 400, { error: 'Choose 1–2000 valid songs' });
      }
      const chosen = trackIds.map(id => tracks.find(track => track.messageId === id));
      if (chosen.some(track => !track)) return json(response, 404, { error: 'Song not found' });
      const pinChannel = selectedChannelId;
      const pinDialog = selectedDialog;
      const pinClient = client;
      const result = await offlineStore.pin(pinChannel, chosen, async (track, offset, length) => {
        let message = selectedChannelId === pinChannel ? messages.get(track.messageId) : null;
        if (!message) message = (await pinClient.getMessages(pinDialog.inputEntity, { ids: track.messageId }))[0];
        if (!message || !songFromMessage(message)) throw new Error('Song is no longer available');
        try { return await fetchTelegramChunk(pinClient, message, offset, length); }
        catch (error) {
          if (!isStaleFileReference(error)) throw error;
          const fresh = (await pinClient.getMessages(pinDialog.inputEntity, { ids: track.messageId }))[0];
          if (!fresh || !songFromMessage(fresh)) throw new Error('Song is no longer available');
          return fetchTelegramChunk(pinClient, fresh, offset, length);
        }
      });
      return json(response, 202, result);
    }
    if (url.pathname === '/offline/unpin' && request.method === 'POST') {
      if (!selectedChannelId) return json(response, 409, { error: 'Choose a channel first' });
      const { trackIds } = await bodyOf(request);
      return json(response, 200, await offlineStore.unpin(selectedChannelId, trackIds));
    }
    if (url.pathname === '/collections' && request.method === 'GET') {
      if (!selectedChannelId) return json(response, 409, { error: 'Choose a channel first' });
      return json(response, 200, { channelId: selectedChannelId, ...collectionsStore.get(selectedChannelId) });
    }
    if (url.pathname === '/collections' && request.method === 'POST') {
      if (!selectedChannelId) return json(response, 409, { error: 'Choose a channel first' });
      const value = await bodyOf(request, 512 * 1024);
      if (value.channelId !== selectedChannelId) return json(response, 409, { error: 'Channel changed' });
      return json(response, 200, await collectionsStore.put(selectedChannelId, value));
    }
    const artMatch = /^\/artwork\/(\d+)$/.exec(url.pathname);
    if (artMatch && request.method === 'GET') {
      if (!selectedChannelId) return json(response, 404, { error: 'No channel selected' });
      const track = tracks.find(item => item.messageId === Number(artMatch[1]));
      if (!track) return json(response, 404, { error: 'Song not found' });
      const artChannel = selectedChannelId;
      const artDialog = selectedDialog;
      const artClient = client;
      const albumParam = url.searchParams.get('album');
      const album = albumParam !== null && albumParam.length <= 100 ? albumParam.trim() :
        collectionsStore.get(artChannel).albumOverrides[String(track.messageId)] ?? '';
      const result = await artworkStore.resolve(artChannel, track, async () => {
        if (!artClient?.connected || !artDialog) throw new Error('Telegram is offline');
        const message = selectedChannelId === artChannel ? messages.get(track.messageId) : null;
        const resolved = message ?? (await artClient.getMessages(artDialog.inputEntity, {
          ids: track.messageId,
        }))[0];
        return resolved ? telegramArtwork(artClient, resolved) : null;
      }, () => archiveArtwork(track, album), album);
      if (!result) return json(response, 404, { error: 'Artwork unavailable' });
      response.writeHead(200, { 'Content-Type': result.mime, 'Content-Length': result.bytes.length,
        'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return response.end(result.bytes);
    }
    const match = /^\/audio\/(\d+)$/.exec(url.pathname);
    if (!match) return json(response, 404, { error: 'Not found' });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(response, 405, { error: 'Method not allowed' });
    }
    const id = Number(match[1]);
    const track = tracks.find(item => item.messageId === id);
    if (!track) return json(response, 404, { error: 'Song not found' });
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
    const pinned = selectedChannelId && offlineStore.get(selectedChannelId, id);
    if (pinned) {
      if (request.method === 'HEAD') { response.writeHead(206, headers); return response.end(); }
      const stream = offlineStore.stream(selectedChannelId, id, parsed.start, end);
      response.writeHead(206, { ...headers, 'X-Telopotify-Offline': 'hit' });
      stream.on('error', () => response.destroy());
      return stream.pipe(response);
    }
    if (!isTelegramOnline()) {
      return json(response, 503, { error: 'Connect to Telegram or pin this song for offline playback' });
    }
    if (unavailable.has(id)) return json(response, 404, { error: 'Song is no longer available' });
    if (request.method === 'HEAD') { response.writeHead(206, headers); return response.end(); }
    let message = messages.get(id);
    if (!message) {
      message = (await client.getMessages(selectedDialog.inputEntity, { ids: id }))[0];
      if (!message || !songFromMessage(message)) {
        markUnavailable(id);
        return json(response, 404, { error: 'Song is no longer available' });
      }
      messages.set(id, message);
    }
    const cacheKey = `${selectedChannelId}:${id}`;
    const cached = audioCache.get(cacheKey, parsed.start, length);
    if (cached) {
      response.writeHead(206, { ...headers, 'X-Telopotify-Cache': 'hit' });
      return response.end(cached);
    }
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    let chunk;
    try {
      chunk = await fetchTelegramChunk(client, message, parsed.start, length, abort.signal);
    } catch (error) {
      if (!isStaleFileReference(error) || abort.signal.aborted) throw error;
      const fresh = (await client.getMessages(selectedDialog.inputEntity, { ids: id }))[0];
      if (!fresh || !songFromMessage(fresh)) {
        markUnavailable(id);
        return json(response, 404, { error: 'Song is no longer available' });
      }
      messages.set(id, fresh);
      chunk = await fetchTelegramChunk(client, fresh, parsed.start, length, abort.signal);
    }
    if (response.destroyed) return;
    audioCache.put(cacheKey, parsed.start, chunk);
    response.writeHead(206, { ...headers, 'X-Telopotify-Cache': 'miss' });
    response.end(chunk);
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      const userError = error instanceof SyntaxError ? 'Invalid JSON' : error.message;
      const statusCode = /Sign in|not active|already|Select|JSON|large|phone number|requested|Invalid collections|Invalid channel|offline|Storage limit|Choose|Wait for/.test(userError) ? 400 : 502;
      json(response, statusCode, { error: userError });
    } else response.destroy();
    if (request.url?.startsWith('/audio/')) console.error(`Audio request failed: ${error.message}`);
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await collectionsStore.load().catch(() => console.warn('Saved collections are unavailable.'));
  await offlineStore.load().catch(() => console.warn('Saved offline songs are unavailable.'));
  await artworkStore.load().catch(() => console.warn('Saved artwork is unavailable.'));
  const server = createServer(handle);
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(BRIDGE_PORT, '127.0.0.1', done);
  });
  const address = `http://127.0.0.1:${server.address().port}?token=${token}`;
  await writeFile(CONNECTION_PATH, JSON.stringify({ address }), { encoding: 'utf8', mode: 0o600 });
  console.log(`Local bridge ready at http://127.0.0.1:${server.address().port}. The app connects automatically.`);
  console.log('Keep this terminal running. Ctrl+C stops the bridge.');
  restoreSession().catch(() => { initializing = false; console.warn('Could not restore Telegram session.'); });
  const syncTimer = setInterval(() => {
    if (isTelegramOnline() && !indexing && !syncing) {
      syncSelectedChannel().catch(() => console.warn('Channel sync will retry later.'));
    }
  }, SYNC_INTERVAL_MS);
  const healthTimer = setInterval(async () => {
    if (initializing || reconnecting || !authenticated || healthChecking) return;
    healthChecking = true;
    try {
      if (!client?.connected) throw new Error('Telegram connection closed');
      await withTimeout(client.invoke(new Api.updates.GetState()), 10_000);
      healthFailures = 0;
    } catch {
      healthFailures++;
      if (healthFailures >= 2) {
        console.warn('Telegram connection stopped responding. Reconnecting saved session.');
        reconnectSavedSession();
      }
    } finally { healthChecking = false; }
  }, 15_000);
  process.on('SIGINT', async () => {
    clearInterval(syncTimer);
    clearInterval(healthTimer);
    server.close();
    await client?.disconnect().catch(() => {});
    await unlink(CONNECTION_PATH).catch(() => {});
    process.exit(0);
  });
}

main().catch(error => { console.error(`Library bridge failed: ${error.message}`); process.exitCode = 1; });
