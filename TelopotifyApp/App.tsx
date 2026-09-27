import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, FlatList, Linking, NativeModules, PanResponder, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text,
  TextInput, useWindowDimensions, View,
} from 'react-native';
import { searchTracks, type Track } from './src/core/library';
import { advanceAfterEnd, createQueue, currentTrackId, moveQueueTrack,
  moveQueueTrackTo, nextTrack, playNextInQueue, previousTrack, removeFromQueue,
  shuffleUpcoming, type QueueState } from './src/core/queue';
import { discoverTracks, fileType, type DurationFilter, type SortOrder } from './src/core/discovery';
import { Icon, type IconName } from './src/components/Icon';

const c = {
  bg: '#0d111b', panel: '#151b29', raised: '#202a3b', line: '#2b3547',
  text: '#f5f7fc', muted: '#9daabd', accent: '#b6a4ff', soft: '#cec5ff',
};

const DISCOVERY_URL = 'http://127.0.0.1:43127/bootstrap';
const BRIDGE_BASE = 'http://127.0.0.1:43127';

function clock(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function size(bytes: number) { return `${(bytes / 1_000_000).toFixed(1)} MB`; }
const coverColors = ['#6c5ab8', '#356e8c', '#a25d83', '#457f75', '#9a6b54'];
function Cover({ track, large = false }: { track?: Track; large?: boolean }) {
  const index = track ? Number(track.messageId) % coverColors.length : 0;
  return <View style={[s.cover, large && s.coverLarge, { backgroundColor: coverColors[index] }]}>
    {track?.title ? <Text style={[s.coverGlyph, large && s.coverGlyphLarge]}>{track.title.slice(0, 1).toUpperCase()}</Text> :
      <Icon name="music" size={large ? 24 : 20} />}
  </View>;
}

type Bridge = { base: string; token: string; online: boolean };
type BridgeStatus = { authenticated: boolean; online: boolean; step: string; error: string;
  channel: string; trackCount: number; selected: boolean; indexing: boolean;
  syncing: boolean; catalogRevision: number; lastSyncedAt: string | null; syncError: string;
  cache: CacheStats; unavailableTrackIds: number[] };
type CacheStats = { bytes: number; limitBytes: number; chunks: number };
type ChannelChoice = { index: number; title: string; selected: boolean };
type LibraryResponse = { channel: string; channelId: string | null; online: boolean; catalogRevision: number;
  unavailableTrackIds: number[]; tracks: Array<{
  messageId: number; title: string; artist: string; durationSeconds: number | null;
  fileSize: number; mimeType: string }> };
type Playlist = { id: string; name: string; trackIds: string[] };
type CollectionsResponse = { channelId: string; favorites: string[]; playlists: Playlist[]; recentTrackIds?: string[];
  queue: { trackIds: string[]; currentTrackId: string | null; repeat: QueueState['repeat'] } };

async function bridgeRequest<T>(connection: Bridge, path: string, data?: object): Promise<T> {
  const response = await fetch(`${connection.base}${path}?token=${encodeURIComponent(connection.token)}`, {
    method: data ? 'POST' : 'GET',
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `Bridge returned ${response.status}`);
  return result;
}

export default function App() {
  const { width } = useWindowDimensions();
  const wide = width >= 800;
  const [query, setQuery] = useState('');
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [authStep, setAuthStep] = useState('phone');
  const [authError, setAuthError] = useState('');
  const [authValue, setAuthValue] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [channelOptions, setChannelOptions] = useState<ChannelChoice[] | null>(null);
  const [channelQuery, setChannelQuery] = useState('');
  const [channelBusy, setChannelBusy] = useState(false);
  const channelsFetched = useRef(false);
  const lastOnline = useRef(false);
  const loadedChannel = useRef('');
  const loadedToken = useRef('');
  const loadedCount = useRef(0);
  const loadedRevision = useRef(-1);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [channelName, setChannelName] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('Looking for your music library…');
  const [syncing, setSyncing] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [syncError, setSyncError] = useState('');
  const [cache, setCache] = useState<CacheStats>({ bytes: 0, limitBytes: 32 * 1024 * 1024, chunks: 0 });
  const [cacheBusy, setCacheBusy] = useState(false);
  const [unavailableTrackIds, setUnavailableTrackIds] = useState<Set<string>>(() => new Set());
  const [playbackNotice, setPlaybackNotice] = useState('');
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState('stopped');
  const [position, setPosition] = useState(0);
  const [nativeDuration, setNativeDuration] = useState(0);
  const [progressWidth, setProgressWidth] = useState(1);
  const [volume, setVolume] = useState(1);
  const [volumeWidth, setVolumeWidth] = useState(1);
  const endedHandled = useRef(false);
  const [page, setPage] = useState<'library' | 'favorites' | 'playlists' | 'queue' | 'recent'>('library');
  const [queue, setQueue] = useState(() => createQueue([]));
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recentTrackIds, setRecentTrackIds] = useState<string[]>([]);
  const [artistFilter, setArtistFilter] = useState('');
  const [durationFilter, setDurationFilter] = useState<DurationFilter>('any');
  const [typeFilter, setTypeFilter] = useState('All types');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [collectionsReady, setCollectionsReady] = useState(false);
  const [collectionError, setCollectionError] = useState('');
  const [activePlaylistId, setActivePlaylistId] = useState('');
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [renamePlaylistName, setRenamePlaylistName] = useState('');
  const [playlistPickerTrackId, setPlaylistPickerTrackId] = useState<string | null>(null);
  const saveTail = useRef<Promise<unknown>>(Promise.resolve());
  const visible = useMemo(() => searchTracks(tracks, query), [tracks, query]);
  const types = useMemo(() => ['All types', ...new Set(tracks.map(fileType).sort())], [tracks]);
  const discovered = useMemo(() => discoverTracks(visible, { artist: artistFilter,
    duration: durationFilter, type: typeFilter, sort: sortOrder }),
    [visible, artistFilter, durationFilter, typeFilter, sortOrder]);
  const activePlaylist = playlists.find(item => item.id === activePlaylistId) ?? playlists[0];
  const selected = tracks.find(track => track.id === currentTrackId(queue));
  const playableTracks = useMemo(() => tracks.filter(track => !unavailableTrackIds.has(track.id)),
    [tracks, unavailableTrackIds]);
  const duration = nativeDuration || selected?.durationSeconds || 0;
  const items = page === 'library' ? discovered : page === 'favorites' ?
    discovered.filter(track => favorites.includes(track.id)) :
    page === 'playlists' ? (activePlaylist?.trackIds ?? []).map(id => tracks.find(track => track.id === id)!).filter(Boolean) :
    page === 'recent' ? recentTrackIds.map(id => tracks.find(track => track.id === id)!).filter(Boolean) :
    queue.trackIds.map(id => tracks.find(track => track.id === id)!).filter(Boolean);

  const playTrack = useCallback(async (track: Track) => {
    if (!bridge?.online) return;
    const url = `${bridge.base}/audio/${track.messageId}?token=${encodeURIComponent(bridge.token)}`;
    try {
      if (Platform.OS === 'windows') {
        if (!NativeModules.TelopotifyAudio) throw new Error('Windows audio module is unavailable');
        NativeModules.TelopotifyAudio.play(url, track.title, track.artist);
      } else {
        await Linking.openURL(url);
      }
      endedHandled.current = false;
      setPlaybackNotice('');
      setPlayingTrackId(track.id);
      setRecentTrackIds(current => [track.id, ...current.filter(id => id !== track.id)].slice(0, 50));
      setPaused(false);
      setPlaybackStatus(Platform.OS === 'windows' ? 'opening' : 'playing');
      setPosition(0);
      setNativeDuration(0);
    } catch (error) {
      setPlaybackNotice(error instanceof Error ? error.message : 'Playback failed');
    }
  }, [bridge]);

  useEffect(() => {
    if (Platform.OS !== 'windows' || !playingTrackId || !bridge?.online) return;
    const refresh = () => {
      try {
        const audio = NativeModules.TelopotifyAudio;
        const command = Number(audio.takeMediaCommand?.() ?? 0);
        if (command === 1 || command === 2) {
          const changed = command === 1 ? nextTrack(queue) : previousTrack(queue);
          const target = tracks.find(track => track.id === currentTrackId(changed));
          if (target && target.id !== playingTrackId) { setQueue(changed); playTrack(target); return; }
        }
        const status = String(audio.getStatus());
        if (status === 'ended' && !endedHandled.current) {
          endedHandled.current = true;
          const next = advanceAfterEnd(queue);
          const target = next && tracks.find(track => track.id === currentTrackId(next));
          if (next && target) {
            setQueue(next);
            playTrack(target);
          } else {
            audio.stop();
            setPlayingTrackId(null);
            setPlaybackStatus('stopped');
            setPosition(0);
          }
          return;
        }
        setPlaybackStatus(status);
        setPaused(status === 'paused');
        setPosition(Number(audio.getPosition()) || 0);
        setNativeDuration(Number(audio.getDuration()) || 0);
      } catch (error) {
        setPlaybackStatus(error instanceof Error ? `error: ${error.message}` : 'error: Playback status unavailable');
      }
    };
    refresh();
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, [playingTrackId, bridge, queue, tracks, playTrack]);

  const loadLibrary = useCallback(async (connection: Bridge) => {
    const data = await bridgeRequest<LibraryResponse>(connection, '/library');
    const identity = data.channelId || data.channel;
    const sameLibrary = identity === loadedChannel.current && connection.token === loadedToken.current;
    const previousCount = loadedCount.current;
    const library: Track[] = data.tracks.map(item => ({
      id: String(item.messageId), channelId: identity, messageId: item.messageId,
      fileId: item.messageId, fileSize: item.fileSize, title: item.title,
      artist: item.artist, durationSeconds: item.durationSeconds, mimeType: item.mimeType,
    }));
    const unavailableIds = new Set((data.unavailableTrackIds ?? []).map(String));
    setUnavailableTrackIds(unavailableIds);
    setTracks(library);
    if (sameLibrary) {
      setQueue(current => {
        const available = new Set(library.filter(track => !unavailableIds.has(track.id)).map(track => track.id));
        const trackIds = current.trackIds.filter(id => available.has(id));
        const currentId = currentTrackId(current);
        return { ...current, trackIds, currentIndex: Math.max(0, trackIds.indexOf(currentId ?? '')) };
      });
    } else {
      setCollectionsReady(false);
      setCollectionError('');
      setFavorites([]);
      setRecentTrackIds([]);
      setArtistFilter('');
      setDurationFilter('any');
      setTypeFilter('All types');
      setSortOrder('newest');
      setPlaylists([]);
      setPlaylistPickerTrackId(null);
      setQueue(createQueue(library.filter(track => !unavailableIds.has(track.id)).map(track => track.id)));
      if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.stop();
      endedHandled.current = false;
      setPlayingTrackId(null);
      setPaused(false);
      setPlaybackStatus('stopped');
      setPosition(0);
    }
    setChannelName(data.channel);
    setBridge({ ...connection, online: data.online });
    loadedChannel.current = identity;
    loadedToken.current = connection.token;
    loadedCount.current = library.length;
    loadedRevision.current = data.catalogRevision ?? 0;
    lastOnline.current = data.online;
    setConnectionStatus(data.online ? sameLibrary && library.length > previousCount ?
      `${library.length - previousCount} new songs added` : `${library.length} songs loaded` :
      library.length ? `${library.length} saved songs · Telegram offline` : 'Sign in and choose a channel');
    if (!sameLibrary && data.channelId) {
      try {
        const saved = await bridgeRequest<CollectionsResponse>(connection, '/collections');
        if (saved.channelId !== data.channelId) throw new Error('Collections belong to another channel');
        const available = new Set(library.filter(track => !unavailableIds.has(track.id)).map(track => track.id));
        const trackIds = saved.queue.trackIds.filter(id => available.has(id));
        setFavorites(saved.favorites);
        setRecentTrackIds((saved.recentTrackIds ?? []).filter(id => library.some(track => track.id === id)));
        setPlaylists(saved.playlists);
        setActivePlaylistId(saved.playlists[0]?.id ?? '');
        setRenamePlaylistName(saved.playlists[0]?.name ?? '');
        setQueue({ trackIds, currentIndex: Math.max(0, trackIds.indexOf(saved.queue.currentTrackId ?? '')),
          repeat: saved.queue.repeat });
        setCollectionsReady(true);
      } catch (error) {
        setCollectionError(error instanceof Error ? error.message : 'Could not load collections');
      }
    }
  }, []);

  useEffect(() => {
    if (!collectionsReady || !bridge || !loadedChannel.current) return;
    const channelId = loadedChannel.current;
    const snapshot = { channelId, favorites, playlists, recentTrackIds,
      queue: { trackIds: queue.trackIds, currentTrackId: currentTrackId(queue), repeat: queue.repeat } };
    const timer = setTimeout(() => {
      saveTail.current = saveTail.current.catch(() => {}).then(() =>
        bridgeRequest(bridge, '/collections', snapshot));
      saveTail.current.catch(error => setCollectionError(error instanceof Error ? error.message :
        'Could not save collections'));
    }, 350);
    return () => clearTimeout(timer);
  }, [bridge, collectionsReady, favorites, playlists, queue, recentTrackIds]);

  const loadChannels = useCallback(async (connection: Bridge) => {
    if (channelsFetched.current) return;
    channelsFetched.current = true;
    try {
      const data = await bridgeRequest<{ channels: ChannelChoice[] }>(connection, '/channels');
      setChannelOptions(data.channels);
    } catch (error) {
      channelsFetched.current = false;
      setConnectionStatus(error instanceof Error ? error.message : 'Could not load channels');
    }
  }, []);

  const refreshStatus = useCallback(async (connection: Bridge) => {
    const data = await bridgeRequest<BridgeStatus>(connection, '/status');
    setAuthenticated(data.authenticated);
    setAuthStep(data.step);
    setAuthError(data.error);
    setSyncing(data.syncing);
    setSyncError(data.syncError || '');
    if (data.cache) setCache(data.cache);
    const missing = new Set((data.unavailableTrackIds ?? []).map(String));
    setUnavailableTrackIds(current => current.size === missing.size &&
      [...current].every(id => missing.has(id)) ? current : missing);
    if (missing.size) {
      setQueue(current => {
        let next = current;
        for (const id of current.trackIds) if (missing.has(id)) next = removeFromQueue(next, id);
        return next;
      });
      if (playingTrackId && missing.has(playingTrackId)) {
        if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.stop();
        setPlayingTrackId(null);
        setPlaybackStatus('stopped');
        setPlaybackNotice('This song is no longer available in Telegram. Choose another song.');
      }
    }
    if (data.authenticated && !data.selected) await loadChannels(connection);
    if (data.online && (!lastOnline.current || data.catalogRevision !== loadedRevision.current)) {
      await loadLibrary(connection);
    }
    if (!data.online) {
      if (lastOnline.current) {
        if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.stop();
        endedHandled.current = false;
        setPlayingTrackId(null);
        setPaused(false);
        setPlaybackStatus('stopped');
        setPosition(0);
        setNativeDuration(0);
        setConnectionStatus(data.trackCount ? `${data.trackCount} saved songs · Telegram offline` : 'Telegram offline');
        setPlaybackNotice('Telegram disconnected. Playback stopped; try again when it reconnects.');
      }
      lastOnline.current = false;
      setBridge(current => current && current.token === connection.token && current.online ?
        { ...current, online: false } : current);
    }
  }, [loadChannels, loadLibrary, playingTrackId]);

  const bridgeBase = bridge?.base;
  const bridgeToken = bridge?.token;
  useEffect(() => {
    if (!bridgeBase || !bridgeToken) return;
    const connection = { base: bridgeBase, token: bridgeToken, online: false };
    let refreshing = false;
    const timer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      refreshStatus(connection).catch(() => {
        lastOnline.current = false;
        if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.stop();
        setPlayingTrackId(null);
        setPaused(false);
        setPlaybackStatus('stopped');
        setPosition(0);
        setNativeDuration(0);
        setPlaybackNotice('The local library stopped. Restart the app to resume streaming.');
        setBridge(null);
        setConnectionStatus('Library service unavailable. Reconnecting…');
      }).finally(() => { refreshing = false; });
    }, 1000);
    return () => clearInterval(timer);
  }, [bridgeBase, bridgeToken, refreshStatus]);

  useEffect(() => {
    if (bridgeBase) return;
    let cancelled = false;
    let connecting = false;
    const connectAutomatically = async () => {
      if (connecting) return;
      connecting = true;
      try {
        const response = await fetch(DISCOVERY_URL);
        if (!response.ok) throw new Error('Local library unavailable');
        const result = await response.json() as { address: string };
        const match = /^http:\/\/127\.0\.0\.1:43127\?token=([a-zA-Z0-9]+)$/.exec(result.address);
        if (!match) throw new Error('Invalid local library address');
        if (cancelled) return;
        const connection = { base: BRIDGE_BASE, token: match[1], online: false };
        await refreshStatus(connection);
        if (!lastOnline.current) await loadLibrary(connection);
      } catch (error) {
        if (!cancelled) setConnectionStatus(`Unable to connect to the local library (${error instanceof Error ? error.message : 'unknown error'}). Retrying…`);
      } finally { connecting = false; }
    };
    connectAutomatically();
    const timer = setInterval(connectAutomatically, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [bridgeBase, refreshStatus, loadLibrary]);

  async function submitAuth() {
    if (!bridge || authBusy) return;
    const value = authValue.trim();
    if (!value) return;
    setAuthValue('');
    setAuthBusy(true);
    setAuthError('');
    try {
      if (authStep === 'phone') await bridgeRequest(bridge, '/auth/start', { phone: value });
      else await bridgeRequest(bridge, '/auth/input', { step: authStep, value });
      await refreshStatus(bridge);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign-in failed');
    } finally { setAuthBusy(false); }
  }

  async function chooseChannel(index: number) {
    if (!bridge || channelBusy) return;
    setChannelBusy(true);
    setConnectionStatus('Indexing channel songs…');
    try {
      await bridgeRequest(bridge, '/channels/select', { index });
      await loadLibrary(bridge);
      setChannelOptions(null);
      channelsFetched.current = false;
    } catch (error) {
      setConnectionStatus(error instanceof Error ? error.message : 'Could not index channel');
    } finally { setChannelBusy(false); }
  }

  async function syncLibrary() {
    if (!bridge?.online || syncBusy || syncing) return;
    setSyncBusy(true);
    setSyncMessage('Checking for new songs…');
    try {
      const result = await bridgeRequest<{ added: number; busy: boolean }>(bridge, '/library/sync', {});
      if (result.busy) setSyncMessage('A sync is already running.');
      else {
        if (result.added) await loadLibrary(bridge);
        setSyncMessage(result.added ? `${result.added} new songs added` : 'Your library is up to date.');
      }
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Could not sync songs');
    } finally { setSyncBusy(false); }
  }

  async function clearCache() {
    if (!bridge || cacheBusy) return;
    setCacheBusy(true);
    try {
      const result = await bridgeRequest<CacheStats>(bridge, '/cache/clear', {});
      setCache(result);
    } catch (error) {
      setConnectionStatus(error instanceof Error ? error.message : 'Could not clear cache');
    } finally { setCacheBusy(false); }
  }

  function toggleFavorite(trackId: string) {
    setFavorites(current => current.includes(trackId) ? current.filter(id => id !== trackId) :
      [...current, trackId]);
    setCollectionError('');
  }

  function createPlaylist() {
    const name = newPlaylistName.trim();
    if (!name || name.length > 60) { setCollectionError('Use a playlist name up to 60 characters.'); return; }
    if (playlists.length >= 50) { setCollectionError('You can have up to 50 playlists.'); return; }
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    setPlaylists(current => [...current, { id, name, trackIds: [] }]);
    setActivePlaylistId(id);
    setRenamePlaylistName(name);
    setNewPlaylistName('');
    setCollectionError('');
  }

  function renamePlaylist() {
    if (!activePlaylist) return;
    const name = renamePlaylistName.trim();
    if (!name || name.length > 60) { setCollectionError('Use a playlist name up to 60 characters.'); return; }
    setPlaylists(current => current.map(item => item.id === activePlaylist.id ? { ...item, name } : item));
    setCollectionError('');
  }

  function deletePlaylist() {
    if (!activePlaylist) return;
    const remaining = playlists.filter(item => item.id !== activePlaylist.id);
    setPlaylists(remaining);
    setActivePlaylistId(remaining[0]?.id ?? '');
    setRenamePlaylistName(remaining[0]?.name ?? '');
    setCollectionError('');
  }

  function togglePlaylistTrack(playlistId: string, trackId: string) {
    setPlaylists(current => current.map(item => item.id !== playlistId ? item : {
      ...item, trackIds: item.trackIds.includes(trackId) ? item.trackIds.filter(id => id !== trackId) :
        [...item.trackIds, trackId],
    }));
    setCollectionError('');
  }

  function playSongs(songIds: string[], startId?: string, shuffle = false) {
    if (!bridge?.online) return;
    const available = songIds.filter(id => playableTracks.some(track => track.id === id));
    const ordered = shuffle ? shuffleUpcoming({ ...createQueue(available), currentIndex: -1 }).trackIds : available;
    const first = ordered.find(id => id === startId) ?? ordered[0];
    const track = playableTracks.find(item => item.id === first);
    if (!track) return;
    setQueue(current => ({ ...createQueue(ordered, first), repeat: current.repeat }));
    playTrack(track);
  }

  function removeQueuedTrack(trackId: string) {
    if (playingTrackId === trackId) {
      if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.stop();
      setPlayingTrackId(null);
      setPaused(false);
      setPlaybackStatus('stopped');
      setPosition(0);
    }
    setQueue(current => removeFromQueue(current, trackId));
  }

  function clearQueue() {
    if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.stop();
    setPlayingTrackId(null);
    setPlaybackStatus('stopped');
    setPosition(0);
    setQueue(current => ({ ...createQueue([]), repeat: current.repeat }));
  }

  async function signOut() {
    if (!bridge) return;
    try {
      await bridgeRequest(bridge, '/auth/logout', {});
      if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.stop();
      endedHandled.current = false;
      setPlayingTrackId(null);
      setBridge({ ...bridge, online: false });
      setTracks([]);
      setQueue(createQueue([]));
      setCollectionsReady(false);
      setFavorites([]);
      setRecentTrackIds([]);
      setPlaylists([]);
      setActivePlaylistId('');
      setCollectionError('');
      setPlaylistPickerTrackId(null);
      setChannelName('');
      loadedChannel.current = '';
      loadedToken.current = '';
      loadedCount.current = 0;
      loadedRevision.current = -1;
      setSyncMessage('');
      setSyncError('');
      setUnavailableTrackIds(new Set());
      setCache(current => ({ ...current, bytes: 0, chunks: 0 }));
      setPlaybackNotice('');
      setAuthenticated(false);
      setAuthStep('phone');
      setAuthValue('');
      setChannelOptions(null);
      channelsFetched.current = false;
      lastOnline.current = false;
      setConnectionStatus('Signed out. Local session and catalog removed.');
    } catch (error) {
      setConnectionStatus(error instanceof Error ? error.message : 'Sign-out failed');
    }
  }

  async function togglePlayback() {
    if (!selected || !bridge?.online) return;
    if (Platform.OS === 'windows' && playingTrackId === selected.id && (paused || showPause)) {
      if (paused) NativeModules.TelopotifyAudio.resume();
      else NativeModules.TelopotifyAudio.pause();
      setPaused(!paused);
      setPlaybackStatus(paused ? 'opening' : 'paused');
      return;
    }
    await playTrack(selected);
  }

  function changeTrack(direction: 'next' | 'previous') {
    const changed = direction === 'next' ? nextTrack(queue) : previousTrack(queue);
    setQueue(changed);
    if (playingTrackId && bridge) {
      const target = tracks.find(track => track.id === currentTrackId(changed));
      if (target && target.id !== playingTrackId) playTrack(target);
    }
  }

  function cycleRepeat() {
    setQueue(current => ({ ...current, repeat: current.repeat === 'off' ? 'all' :
      current.repeat === 'all' ? 'one' : 'off' }));
  }

  function changeVolume(value: number) {
    const level = Math.max(0, Math.min(1, value));
    setVolume(level);
    if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.setVolume(level);
  }

  function seekTo(seconds: number) {
    if (Platform.OS !== 'windows' || !playingTrackId || !duration ||
        playbackStatus.startsWith('error:')) return;
    const target = Math.max(0, Math.min(duration, seconds));
    NativeModules.TelopotifyAudio.seek(target);
    setPosition(target);
  }

  const online = Boolean(bridge?.online);
  const showPause = playingTrackId === selected?.id && !paused &&
    ['opening', 'buffering', 'playing'].includes(playbackStatus);
  const currentLabel = online ? 'Ready to stream' : bridge ? 'Telegram offline' :
    connectionStatus.startsWith('Unable') ? 'Connection issue' : 'Connecting';
  const pageTitle = page === 'library' ? 'Your music' : page === 'favorites' ? 'Favorites' :
    page === 'playlists' ? 'Playlists' : page === 'recent' ? 'Recently played' : 'Play queue';

  return <View style={s.root}>
    <StatusBar barStyle="light-content" backgroundColor={c.bg} />
    <View style={s.body}>
      {wide && <View style={s.sidebar}>
        <View style={s.brandRow}><View style={s.brandMark}><Icon name="music" size={22} color={c.bg} /></View>
          <View><Text style={s.brand}>telopotify</Text><Text style={s.brandTag}>TELEGRAM MUSIC</Text></View></View>
        <Text style={s.navCaption}>YOUR SPACE</Text>
        <Nav icon="library" label="Library" active={page === 'library'} onPress={() => setPage('library')} />
        <Nav icon="favorite" label="Favorites" active={page === 'favorites'} onPress={() => setPage('favorites')} />
        <Nav icon="playlist" label="Playlists" active={page === 'playlists'} onPress={() => setPage('playlists')} />
        <Nav icon="queue" label="Queue" active={page === 'queue'} onPress={() => setPage('queue')} />
        <Nav icon="recent" label="Recently played" active={page === 'recent'} onPress={() => setPage('recent')} />
        <View style={s.sidebarDivider} />
        <Text style={s.navCaption}>YOUR COLLECTION</Text>
        <View style={s.collectionCard}><View style={s.collectionIcon}><Icon name="music" size={18} /></View>
          <View style={s.trackText}><Text numberOfLines={1} style={s.collectionTitle}>{channelName || 'Telegram channel'}</Text>
            <Text style={s.collectionCount}>{tracks.length} songs</Text></View></View>
        <View style={s.sidebarBottom}>
          {bridge && <CacheInfo stats={cache} busy={cacheBusy} onClear={clearCache} />}
          <View style={s.sidebarDivider} />
          <View style={s.statusRow}><View style={[s.statusDot, !online && s.statusDotIdle]} />
            <Text style={s.statusText}>{currentLabel}</Text></View>
          <Text style={s.connection} numberOfLines={2}>{connectionStatus}</Text>
        </View>
      </View>}
      <View style={s.main}>
        {!wide && <View style={s.compactNav}>
          <Text style={s.compactBrand}>telopotify</Text>
          <Nav icon="library" label="Library" active={page === 'library'} onPress={() => setPage('library')} />
          <Nav icon="favorite" label="Favorites" active={page === 'favorites'} onPress={() => setPage('favorites')} />
          <Nav icon="playlist" label="Playlists" active={page === 'playlists'} onPress={() => setPage('playlists')} />
          <Nav icon="queue" label="Queue" active={page === 'queue'} onPress={() => setPage('queue')} />
          <Nav icon="recent" label="Recent" active={page === 'recent'} onPress={() => setPage('recent')} />
        </View>}
        <View style={s.topLine}><Text style={s.breadcrumb}>MY MUSIC  /  {page.toUpperCase()}</Text>
          <View style={s.topStatus}><View style={[s.statusDot, !online && s.statusDotIdle]} />
            <Text style={s.topStatusText}>{currentLabel}</Text></View></View>
        <Text style={s.heading}>{pageTitle}</Text>
        <Text style={s.subtitle}>{page === 'library' ? 'Every song from your channel, ready when you are.' :
          page === 'favorites' ? 'The songs you keep coming back to.' :
          page === 'playlists' ? 'Build your own collections from the channel.' :
          'The songs lined up for your listening session.'}</Text>
        {!bridge && <View style={s.setupPanel}>
          <Text style={s.setupTitle}>Finding your local library…</Text>
          <Text style={s.setupHelp}>{connectionStatus}</Text>
        </View>}
        {bridge && !authenticated && <View style={s.setupPanel}>
          <Text style={s.setupTitle}>{authStep === 'connecting' ? 'Reconnecting to Telegram' : 'Telegram sign-in'}</Text>
          <Text style={s.setupHelp}>{authStep === 'phone' ? 'Enter your phone number with country code.' :
            authStep === 'code' ? 'Enter the code Telegram sent you.' :
            authStep === 'password' ? 'Enter your two-step verification password.' :
            authStep === 'email' ? 'Enter the email address Telegram requested.' :
            authStep === 'emailCode' ? 'Enter the code sent to your email.' :
            'Your saved songs are still here. Telegram will reconnect automatically.'}</Text>
          {['phone', 'code', 'password', 'email', 'emailCode'].includes(authStep) && <View style={s.connectRow}>
            <TextInput accessibilityLabel={authStep === 'phone' ? 'Telegram phone number' : 'Telegram verification input'}
              placeholder={authStep === 'phone' ? '+15555550123' : authStep === 'password' ? 'Two-step password' : 'Verification code'}
              placeholderTextColor={c.muted} value={authValue} onChangeText={setAuthValue}
              secureTextEntry={authStep !== 'phone' && authStep !== 'email'}
              autoCapitalize="none" autoCorrect={false} style={[s.search, s.connectInput]} />
            <Pressable accessibilityRole="button" accessibilityLabel="Continue Telegram sign-in"
              disabled={authBusy || !authValue.trim()} onPress={submitAuth} style={s.connectButton}>
              <Text style={s.connectButtonText}>Continue</Text>
            </Pressable>
          </View>}
          {!!authError && <Text style={s.authError}>{authError}</Text>}
        </View>}
        {bridge && authenticated && <View style={[s.accountRow, !wide && s.accountRowCompact]}>
          <View style={s.accountBadge}><View style={s.statusDot} /><Text style={s.accountText}>Telegram connected</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Choose Telegram channel"
            onPress={() => { channelsFetched.current = false; loadChannels(bridge); }}>
            <Text style={s.accountAction}>Choose channel</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Sign out of Telegram"
            onPress={signOut}><Text style={s.accountAction}>Sign out</Text></Pressable>
        </View>}
        {!wide && bridge && <View style={s.compactCache}><CacheInfo stats={cache} busy={cacheBusy} onClear={clearCache} /></View>}
        {!!(playbackNotice || playbackStatus.startsWith('error:')) && <View style={s.playbackAlert}>
          <View style={s.alertCopy}><Text style={s.alertTitle}>Playback interrupted</Text>
            <Text style={s.alertDetail}>{playbackNotice || 'Could not stream this song. Check the connection and try again.'}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry playback" disabled={!online || !selected}
            onPress={() => selected && playTrack(selected)} style={[s.alertAction, (!online || !selected) && s.syncButtonDisabled]}>
            <Icon name="sync" size={15} color={c.soft} /><Text style={s.alertActionText}>Retry</Text>
          </Pressable>
        </View>}
        {!!collectionError && <Text style={s.authError}>{collectionError}</Text>}
        {page === 'playlists' && <View style={s.playlistPanel}>
          <Text style={s.panelEyebrow}>YOUR PLAYLISTS</Text>
          <View style={s.playlistCreateRow}>
            <TextInput accessibilityLabel="New playlist name" placeholder="Name a new playlist"
              placeholderTextColor={c.muted} value={newPlaylistName} onChangeText={setNewPlaylistName}
              maxLength={60} style={[s.search, s.playlistInput]} />
            <Pressable accessibilityRole="button" accessibilityLabel="Create playlist"
              disabled={!collectionsReady || !newPlaylistName.trim()} onPress={createPlaylist}
              style={[s.smallPrimary, (!collectionsReady || !newPlaylistName.trim()) && s.syncButtonDisabled]}>
              <Icon name="add" size={15} color={c.bg} /><Text style={s.smallPrimaryText}>Create</Text>
            </Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.playlistTabs}>
            {playlists.map(item => <Pressable key={item.id} accessibilityRole="button"
              accessibilityLabel={`Open playlist ${item.name}`} onPress={() => {
                setActivePlaylistId(item.id); setRenamePlaylistName(item.name);
              }} style={[s.playlistTab, activePlaylist?.id === item.id && s.playlistTabActive]}>
              <Icon name="playlist" size={15} color={activePlaylist?.id === item.id ? c.soft : c.muted} />
              <Text numberOfLines={1} style={s.playlistTabText}>{item.name}</Text>
              <Text style={s.playlistTabCount}>{item.trackIds.length}</Text>
            </Pressable>)}
          </ScrollView>
          {activePlaylist && <View style={s.playlistEditRow}>
            <TextInput accessibilityLabel="Rename playlist" value={renamePlaylistName}
              onChangeText={setRenamePlaylistName} maxLength={60} style={[s.search, s.playlistInput]} />
            <Pressable accessibilityRole="button" accessibilityLabel="Save playlist name"
              onPress={renamePlaylist} style={s.smallSecondary}><Icon name="playlist" size={15} color={c.soft} />
              <Text style={s.smallSecondaryText}>Rename</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Play playlist"
              disabled={!activePlaylist.trackIds.length || !online}
              onPress={() => playSongs(activePlaylist.trackIds)} style={[s.smallSecondary,
                (!activePlaylist.trackIds.length || !online) && s.syncButtonDisabled]}>
              <Icon name="play" size={15} color={c.soft} /><Text style={s.smallSecondaryText}>Play</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Delete playlist"
              onPress={deletePlaylist} style={s.smallDanger}><Icon name="delete" size={15} color="#ffc7d1" /></Pressable>
          </View>}
          {!playlists.length && <Text style={s.panelHelp}>Create a playlist, then use the list icon beside a song to add it.</Text>}
        </View>}
        {playlistPickerTrackId && <View style={s.playlistPanel}>
          <View style={s.pickerHeading}><Text style={s.setupTitle}>Add to playlist</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close playlist picker"
              onPress={() => setPlaylistPickerTrackId(null)}><Icon name="remove" size={18} color={c.muted} /></Pressable></View>
          <Text style={s.panelHelp} numberOfLines={1}>{tracks.find(track => track.id === playlistPickerTrackId)?.title}</Text>
          <View style={s.pickerChoices}>{playlists.map(item => <Pressable key={item.id}
            accessibilityRole="button" accessibilityLabel={`${item.trackIds.includes(playlistPickerTrackId) ? 'Remove from' : 'Add to'} playlist ${item.name}`}
            onPress={() => togglePlaylistTrack(item.id, playlistPickerTrackId)}
            style={[s.playlistTab, item.trackIds.includes(playlistPickerTrackId) && s.playlistTabActive]}>
            <Icon name={item.trackIds.includes(playlistPickerTrackId) ? 'favoriteFilled' : 'add'} size={15} color={c.soft} />
            <Text numberOfLines={1} style={s.playlistTabText}>{item.name}</Text></Pressable>)}</View>
          {!playlists.length && <Text style={s.panelHelp}>Create a playlist in the Playlists tab first.</Text>}
        </View>}
        {bridge && authenticated && channelOptions && <View style={s.setupPanel}>
          <Text style={s.setupTitle}>Choose a channel</Text>
          <TextInput accessibilityLabel="Search channels" placeholder="Search channels"
            placeholderTextColor={c.muted} value={channelQuery} onChangeText={setChannelQuery}
            style={s.channelSearch} />
          <ScrollView style={s.channelList} nestedScrollEnabled>
            {channelOptions.filter(item => item.title.toLocaleLowerCase().includes(channelQuery.toLocaleLowerCase()))
              .map(item => <Pressable key={item.index} accessibilityRole="button"
                accessibilityLabel={`Choose ${item.title}`} disabled={channelBusy}
                onPress={() => chooseChannel(item.index)} style={s.channelItem}>
                <Text numberOfLines={1} style={s.channelText}>{item.title}{item.selected ? ' · current' : ''}</Text>
              </Pressable>)}
          </ScrollView>
          {channelBusy && <Text style={s.setupHelp}>Indexing songs without downloading audio…</Text>}
        </View>}
        {tracks.length > 0 && page === 'library' && <View style={s.hero}>
          <View style={s.heroAccent} />
          <View style={s.heroCopy}><Text style={s.heroEyebrow}>YOUR CHANNEL COLLECTION</Text>
            <Text numberOfLines={2} style={s.heroTitle}>{channelName || 'Your music'}</Text>
            <Text style={s.heroMeta}>{tracks.length.toLocaleString()} songs  ·  Stream without downloading your library</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Play library"
              disabled={!online || !discovered.some(track => !unavailableTrackIds.has(track.id))} onPress={() => {
                playSongs(discovered.map(track => track.id));
              }}
              style={[s.heroPlay, (!online || !discovered.some(track => !unavailableTrackIds.has(track.id))) && s.heroPlayDisabled]}><Icon name="play" size={15} color="#1b1730" />
              <Text style={s.heroPlayText}>Play collection</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Shuffle library"
              disabled={!online || !discovered.some(track => !unavailableTrackIds.has(track.id))}
              onPress={() => playSongs(discovered.map(track => track.id), undefined, true)} style={s.heroShuffle}>
              <Icon name="shuffle" size={15} color={c.soft} /><Text style={s.syncButtonText}>Shuffle collection</Text>
            </Pressable>
          </View>{wide && <View style={s.heroArt}><View style={s.heroRecord}><View style={s.heroRecordInner}>
            <Icon name="music" size={28} color={c.soft} /></View></View></View>}
        </View>}
        <View style={[s.toolbar, !wide && s.toolbarCompact]}><View><Text style={s.section}>{page === 'library' ? 'All songs' :
          page === 'favorites' ? 'Liked songs' : page === 'playlists' ? activePlaylist?.name ?? 'Playlist songs' :
          page === 'recent' ? 'Your latest listens' : 'Up next'}</Text>
          <Text style={s.sectionSub}>{items.length.toLocaleString()} tracks{(page === 'library' || page === 'favorites') && query ? ' found' : ''}{syncError ? ' · Sync will retry when Telegram is available.' : syncMessage ? ` · ${syncMessage}` : ''}</Text></View>
          <View style={[s.toolbarActions, !wide && s.toolbarActionsCompact]}>
            {page === 'library' && <Pressable accessibilityRole="button" accessibilityLabel="Sync new songs"
              disabled={!online || syncBusy || syncing} onPress={syncLibrary}
              style={[s.syncButton, (!online || syncBusy || syncing) && s.syncButtonDisabled]}>
              <Icon name="sync" size={15} color={c.soft} /><Text style={s.syncButtonText}>{syncBusy || syncing ? 'Syncing' : 'Sync'}</Text>
            </Pressable>}
            {(page === 'favorites' || page === 'playlists' || page === 'recent') && !!items.length && <Pressable
              accessibilityRole="button" accessibilityLabel="Play all shown songs" disabled={!online}
              onPress={() => playSongs(items.map(track => track.id))}
              style={[s.syncButton, !online && s.syncButtonDisabled]}><Icon name="play" size={15} color={c.soft} />
              <Text style={s.syncButtonText}>Play all</Text></Pressable>}
            {(page === 'favorites' || page === 'playlists' || page === 'recent') && !!items.length && <Pressable
              accessibilityRole="button" accessibilityLabel="Shuffle shown songs" disabled={!online}
              onPress={() => playSongs(items.map(track => track.id), undefined, true)}
              style={[s.syncButton, !online && s.syncButtonDisabled]}><Icon name="shuffle" size={15} color={c.soft} />
              <Text style={s.syncButtonText}>Shuffle</Text></Pressable>}
            {page === 'queue' && queue.trackIds.length > 2 && <Pressable accessibilityRole="button"
              accessibilityLabel="Shuffle upcoming songs" onPress={() => setQueue(current => shuffleUpcoming(current))}
              style={s.syncButton}><Icon name="shuffle" size={15} color={c.soft} /><Text style={s.syncButtonText}>Shuffle next</Text></Pressable>}
            {page === 'queue' && !!queue.trackIds.length && <Pressable accessibilityRole="button"
              accessibilityLabel="Clear play queue" onPress={clearQueue} style={s.syncButton}>
              <Icon name="remove" size={15} color={c.soft} /><Text style={s.syncButtonText}>Clear queue</Text>
            </Pressable>}
            {(page === 'library' || page === 'favorites') && <View style={[s.searchBox, !wide && s.searchCompact]}>
              <Icon name="search" size={16} color={c.muted} />
              <TextInput accessibilityLabel="Search songs" placeholder="Search songs or artists"
                placeholderTextColor={c.muted} value={query} onChangeText={setQuery} style={s.searchField} /></View>}
          </View></View>
        {(page === 'library' || page === 'favorites') && <View style={s.filterBar}>
          <TextInput accessibilityLabel="Filter by artist" placeholder="Filter artist"
            placeholderTextColor={c.muted} value={artistFilter} onChangeText={setArtistFilter}
            style={s.artistFilter} />
          <FilterChip label={`Duration: ${durationFilter === 'any' ? 'Any' : durationFilter === 'short' ? '< 3 min' :
            durationFilter === 'medium' ? '3–6 min' : '6+ min'}`} onPress={() => setDurationFilter(current =>
            ({ any: 'short', short: 'medium', medium: 'long', long: 'any' } as const)[current])} />
          <FilterChip label={`Type: ${typeFilter}`} onPress={() => setTypeFilter(current =>
            types[(types.indexOf(current) + 1) % types.length])} />
          <FilterChip label={`Sort: ${sortOrder}`} onPress={() => setSortOrder(current =>
            ({ newest: 'title', title: 'artist', artist: 'duration', duration: 'newest' } as const)[current])} />
        </View>}
        <View style={s.tableHead}><Text style={s.tableNumber}>#</Text><View style={s.tableCover} /><Text style={s.tableTitle}>TITLE</Text>
          {wide && <Text style={s.tableSize}>SIZE</Text>}<Text style={s.tableDuration}>TIME</Text>
          <View style={[s.tableActions, page === 'queue' && s.tableQueueActions]} /></View>
        <FlatList data={items} keyExtractor={item => item.id}
          renderItem={({ item, index }) => <View
            style={[s.row, selected?.id === item.id && s.selected, unavailableTrackIds.has(item.id) && s.unavailableRow]}>
            <Pressable accessibilityRole="button"
              accessibilityLabel={unavailableTrackIds.has(item.id) ? `${item.title} unavailable` : `Play ${item.title}`}
              disabled={unavailableTrackIds.has(item.id)}
              onPress={() => {
                if (page === 'queue') {
                  setQueue(current => ({ ...current, currentIndex: current.trackIds.indexOf(item.id) }));
                  playTrack(item);
                } else playSongs(page === 'playlists' ? activePlaylist?.trackIds ?? [] :
                  items.map(track => track.id), item.id);
              }} style={s.rowMain}>
              <Text style={[s.rowNumber, selected?.id === item.id && s.activeRowText]}>{String(index + 1).padStart(2, '0')}</Text>
              <Cover track={item} />
              <View style={s.trackText}>
                <Text numberOfLines={1} style={[s.trackTitle, selected?.id === item.id && s.activeRowText]}>{item.title}</Text>
                <Text numberOfLines={1} style={s.trackArtist}>{item.artist}{unavailableTrackIds.has(item.id) ? ' · Unavailable' : ''}</Text>
              </View>
            </Pressable>
            {wide && <Text style={s.rowSize}>{size(item.fileSize)}</Text>}
            <Text style={s.rowDuration}>{item.durationSeconds ? clock(item.durationSeconds) : '—'}</Text>
            <View style={s.rowActions}>
              {page !== 'queue' && <RowAction icon={favorites.includes(item.id) ? 'favoriteFilled' : 'favorite'}
                label={`${favorites.includes(item.id) ? 'Remove' : 'Add'} favorite ${item.title}`}
                active={favorites.includes(item.id)} onPress={() => toggleFavorite(item.id)} />}
              {(page === 'library' || page === 'favorites' || page === 'recent') && <RowAction icon="playlist"
                label={`Add ${item.title} to playlist`} disabled={!collectionsReady}
                onPress={() => setPlaylistPickerTrackId(item.id)} />}
              {page === 'playlists' && activePlaylist && <RowAction icon="remove"
                label={`Remove ${item.title} from playlist`} onPress={() => togglePlaylistTrack(activePlaylist.id, item.id)} />}
              {page !== 'queue' && <RowAction icon="add" label={`Play ${item.title} next`}
                disabled={unavailableTrackIds.has(item.id)} onPress={() => setQueue(current => playNextInQueue(current, item.id))} />}
              {page === 'queue' && <>
                <QueueDragHandle trackId={item.id} index={index} onDrop={destination =>
                  setQueue(current => moveQueueTrackTo(current, item.id, destination))} />
                <RowAction icon="up" label={`Move ${item.title} up`} disabled={index === 0}
                  onPress={() => setQueue(current => moveQueueTrack(current, item.id, -1))} />
                <RowAction icon="down" label={`Move ${item.title} down`} disabled={index === items.length - 1}
                  onPress={() => setQueue(current => moveQueueTrack(current, item.id, 1))} />
                <RowAction icon="remove" label={`Remove ${item.title} from queue`}
                  onPress={() => removeQueuedTrack(item.id)} />
              </>}
            </View>
          </View>}
          ListEmptyComponent={<View style={s.emptyCard}><Icon name="music" size={28} color={c.accent} />
            <Text style={s.emptyTitle}>{query && (page === 'library' || page === 'favorites') ? 'No songs found' :
              (page === 'library' && tracks.length || page === 'favorites' && favorites.length) ? 'No matching songs' :
              page === 'queue' ? 'Your queue is empty' : page === 'favorites' ? 'No favorites yet' :
              page === 'playlists' ? 'This playlist is empty' : page === 'recent' ? 'Nothing played yet' :
              'Your songs will appear here'}</Text>
            <Text style={s.empty}>{page === 'favorites' ? 'Use the star beside a song to save it here.' :
              page === 'playlists' ? 'Add songs using the playlist icon in your library.' :
              page === 'queue' ? 'Add songs from your library or a playlist.' :
              page === 'recent' ? 'Songs you play will show up here.' :
              (page === 'library' && tracks.length || page === 'favorites' && favorites.length) ?
                'Try changing the search or filters.' : connectionStatus}</Text></View>} />
      </View>
    </View>
    <View style={[s.playerBar, !wide && s.playerBarCompact]}>
      <View style={s.nowPlaying}>
        <Cover track={selected} large />
        <View style={s.trackText}>
          <Text numberOfLines={1} style={s.playerTitle}>{selected?.title ?? 'Choose a song'}</Text>
          <Text numberOfLines={1} style={s.trackArtist}>{selected?.artist || 'Your channel music will appear here'}</Text>
        </View>
      </View>
      <View style={s.playerCenter}>
      <View style={s.transport}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Repeat ${queue.repeat}`}
          accessibilityHint="Cycles through off, all songs, and one song"
          onPress={cycleRepeat} style={s.repeatButton}>
          <Icon name={queue.repeat === 'one' ? 'repeatOne' : 'repeatAll'} size={19}
            color={queue.repeat === 'off' ? c.muted : c.accent} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous track"
          onPress={() => changeTrack('previous')} style={s.transportButton}>
          <Icon name="previous" size={20} color={c.muted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={showPause ? 'Pause selected song' : 'Play selected song'}
          onPress={togglePlayback} disabled={!bridge?.online || !selected}
          style={[s.disabledPlay, online && s.enabledPlay]}><Icon name={showPause ? 'pause' : 'play'}
            size={20} color={online ? '#1b1730' : c.muted} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Next track"
          onPress={() => changeTrack('next')} style={s.transportButton}>
          <Icon name="next" size={20} color={c.muted} />
        </Pressable>
      </View>
      <View style={s.progressRow}>
        <Text style={s.time}>{clock(position)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Seek in song"
          onLayout={event => setProgressWidth(event.nativeEvent.layout.width)}
          onPress={event => seekTo(duration * event.nativeEvent.locationX / progressWidth)}
          style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${duration ? Math.min(100, position / duration * 100) : 0}%` }]} />
        </Pressable>
        <Text style={s.time}>{clock(duration)}</Text>
      </View>
      </View>
      {wide && <View style={s.playerRight}>
        <Text style={s.playerRightLabel}>{playbackStatus.startsWith('error:') ? 'PLAYBACK ERROR' :
          playingTrackId === selected?.id ? playbackStatus.toUpperCase() : 'READY TO PLAY'}</Text>
        <View style={s.volumeRow}><Icon name="volume" size={17} color={c.muted} />
          <Pressable accessibilityRole="adjustable" accessibilityLabel="Volume"
            accessibilityValue={{ min: 0, max: 100, now: Math.round(volume * 100) }}
            onLayout={event => setVolumeWidth(event.nativeEvent.layout.width)}
            onPress={event => changeVolume(event.nativeEvent.locationX / volumeWidth)}
            style={s.volumeTrack}><View style={[s.volumeFill, { width: `${volume * 100}%` }]} /></Pressable>
          <Text style={s.volumeValue}>{Math.round(volume * 100)}%</Text></View></View>}
    </View>
  </View>;
}

function RowAction({ icon, label, active = false, disabled = false, onPress }:
  { icon: IconName; label: string; active?: boolean; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    onPress={onPress} style={[s.rowAction, disabled && s.rowActionDisabled]}>
    <Icon name={icon} size={16} color={active ? c.accent : c.muted} />
  </Pressable>;
}

function FilterChip({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={s.filterChip}>
    <Text numberOfLines={1} style={s.filterText}>{label}</Text>
  </Pressable>;
}

function QueueDragHandle({ trackId, index, onDrop }:
  { trackId: string; index: number; onDrop: (destination: number) => void }) {
  const offset = useRef(new Animated.Value(0)).current;
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderMove: (_, gesture) => offset.setValue(gesture.dy),
    onPanResponderRelease: (_, gesture) => {
      offset.setValue(0);
      onDrop(index + Math.round(gesture.dy / 56));
    },
    onPanResponderTerminate: () => offset.setValue(0),
  }), [index, offset, onDrop]);
  return <Animated.View {...responder.panHandlers} accessibilityRole="button"
    accessibilityLabel={`Drag ${trackId} to reorder`} style={[s.dragHandle, { transform: [{ translateY: offset }] }]}>
    <Icon name="drag" size={17} color={c.muted} />
  </Animated.View>;
}

function CacheInfo({ stats, busy, onClear }: { stats: CacheStats; busy: boolean; onClear: () => void }) {
  const used = (stats.bytes / 1048576).toFixed(1);
  const limit = Math.round(stats.limitBytes / 1048576);
  return <View style={s.cacheCard}>
    <View style={s.cacheHeader}><Text style={s.cacheTitle}>STREAMING CACHE</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Clear streaming cache"
        disabled={busy || !stats.bytes} onPress={onClear}>
        <Text style={[s.cacheClear, (busy || !stats.bytes) && s.cacheClearDisabled]}>Clear</Text>
      </Pressable></View>
    <Text style={s.cacheValue}>{used} MB <Text style={s.cacheLimit}>/ {limit} MB</Text></Text>
    <View style={s.cacheMeter}><View style={[s.cacheMeterFill,
      { width: `${stats.limitBytes ? Math.min(100, stats.bytes / stats.limitBytes * 100) : 0}%` }]} /></View>
    <Text style={s.cacheHint}>Recent audio only · cleared on restart</Text>
  </View>;
}

function Nav({ icon, label, active, onPress }: { icon: IconName; label: string; active: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }}
    onPress={onPress} style={[s.nav, active && s.navActive]}>
    <Icon name={icon} size={18} color={active ? c.text : c.muted} />
    <Text style={[s.navText, active && s.navTextActive]}>{label}</Text>
  </Pressable>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  body: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 246, padding: 20, backgroundColor: c.panel, borderRightWidth: 1, borderColor: c.line },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 46 },
  brandMark: { width: 37, height: 37, borderRadius: 12, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  brand: { color: c.text, fontSize: 21, fontWeight: '800', letterSpacing: -0.7 },
  brandTag: { color: c.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1.3, marginTop: 1 },
  navCaption: { color: '#708098', fontSize: 10, fontWeight: '800', letterSpacing: 1.6, marginBottom: 12, paddingHorizontal: 12 },
  sidebarDivider: { height: 1, backgroundColor: c.line, marginVertical: 22 },
  collectionCard: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 10, backgroundColor: c.raised },
  collectionIcon: { width: 34, height: 34, borderRadius: 7, backgroundColor: '#6c5ab8', alignItems: 'center', justifyContent: 'center', marginRight: 9 },
  collectionTitle: { color: c.text, fontSize: 12, fontWeight: '700' },
  collectionCount: { color: c.muted, fontSize: 11, marginTop: 3 },
  sidebarBottom: { marginTop: 'auto' },
  cacheCard: { backgroundColor: c.raised, borderRadius: 11, padding: 12, borderWidth: 1, borderColor: c.line },
  compactCache: { marginBottom: 16 },
  cacheHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cacheTitle: { color: c.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1.1 },
  cacheClear: { color: c.soft, fontSize: 11, fontWeight: '700' },
  cacheClearDisabled: { opacity: 0.45 },
  cacheValue: { color: c.text, fontSize: 16, fontWeight: '800', marginTop: 8 },
  cacheLimit: { color: c.muted, fontSize: 11, fontWeight: '500' },
  cacheMeter: { height: 4, backgroundColor: '#394459', borderRadius: 2, marginTop: 8 },
  cacheMeterFill: { height: 4, backgroundColor: c.accent, borderRadius: 2 },
  cacheHint: { color: c.muted, fontSize: 10, marginTop: 7 },
  connection: { color: c.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#61d9a8' },
  statusDotIdle: { backgroundColor: '#e8b873' },
  statusText: { color: c.text, fontSize: 12, fontWeight: '700' },
  nav: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 15, borderRadius: 9, marginBottom: 5, gap: 13 },
  navActive: { backgroundColor: '#2a2545' },
  navText: { color: c.muted, fontSize: 14, fontWeight: '600' },
  navTextActive: { color: c.text },
  compactNav: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 17, gap: 4 },
  compactBrand: { color: c.text, fontSize: 17, fontWeight: '800', width: '100%', marginBottom: 8 },
  main: { flex: 1, paddingHorizontal: 30, paddingTop: 26, paddingBottom: 10 },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  breadcrumb: { color: c.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  topStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: c.panel,
    borderWidth: 1, borderColor: c.line, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 20 },
  topStatusText: { color: c.muted, fontSize: 11, fontWeight: '600' },
  heading: { color: c.text, fontSize: 33, fontWeight: '800', letterSpacing: -1.2 },
  subtitle: { color: c.muted, fontSize: 13, marginTop: 5, marginBottom: 20 },
  search: { width: 260, backgroundColor: c.panel, borderColor: c.line, borderWidth: 1, borderRadius: 9,
    color: c.text, paddingHorizontal: 14, paddingVertical: 8, fontSize: 12 },
  connectRow: { flexDirection: 'row', gap: 10 },
  connectInput: { flex: 1 },
  connectButton: { height: 42, paddingHorizontal: 18, borderRadius: 9, backgroundColor: c.accent,
    alignItems: 'center', justifyContent: 'center' },
  connectButtonText: { color: c.bg, fontWeight: '800' },
  setupPanel: { backgroundColor: c.panel, borderColor: c.line, borderWidth: 1,
    borderRadius: 12, padding: 16, marginBottom: 16 },
  setupTitle: { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  setupHelp: { color: c.muted, fontSize: 13 },
  authError: { color: '#ffaaa8', fontSize: 13 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 18, marginBottom: 16 },
  accountRowCompact: { flexWrap: 'wrap', gap: 12 },
  accountBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#19372f', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  accountText: { color: '#82dfb9', fontSize: 11, fontWeight: '700' },
  accountAction: { color: c.muted, fontSize: 11, fontWeight: '600' },
  playbackAlert: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, marginBottom: 15,
    backgroundColor: '#3a252d', borderColor: '#80525f', borderWidth: 1, borderRadius: 11 },
  alertCopy: { flex: 1 },
  alertTitle: { color: '#ffd6db', fontSize: 12, fontWeight: '800' },
  alertDetail: { color: '#e4b8c2', fontSize: 11, marginTop: 3 },
  alertAction: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11,
    paddingVertical: 8, backgroundColor: '#5a3745', borderRadius: 8 },
  alertActionText: { color: c.soft, fontSize: 11, fontWeight: '700' },
  playlistPanel: { backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, padding: 15, marginBottom: 16 },
  panelEyebrow: { color: c.soft, fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginBottom: 10 },
  panelHelp: { color: c.muted, fontSize: 12, marginTop: 8 },
  playlistCreateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  playlistInput: { flex: 1, minWidth: 100, width: undefined },
  smallPrimary: { height: 36, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.accent,
    flexDirection: 'row', alignItems: 'center', gap: 5 },
  smallPrimaryText: { color: c.bg, fontSize: 12, fontWeight: '800' },
  smallSecondary: { height: 36, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.raised,
    borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', gap: 5 },
  smallSecondaryText: { color: c.soft, fontSize: 11, fontWeight: '700' },
  smallDanger: { height: 36, width: 36, borderRadius: 8, backgroundColor: '#54313c',
    alignItems: 'center', justifyContent: 'center' },
  playlistTabs: { marginTop: 12 },
  playlistTab: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 8,
    paddingHorizontal: 11, height: 34, backgroundColor: c.raised, borderWidth: 1,
    borderColor: c.line, marginRight: 7, maxWidth: 200 },
  playlistTabActive: { backgroundColor: '#342d57', borderColor: '#6b5e9d' },
  playlistTabText: { color: c.text, fontSize: 11, fontWeight: '700', flexShrink: 1 },
  playlistTabCount: { color: c.muted, fontSize: 10 },
  playlistEditRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 12, flexWrap: 'wrap' },
  pickerHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pickerChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10 },
  channelSearch: { backgroundColor: c.raised, borderRadius: 8, color: c.text,
    paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  channelList: { maxHeight: 180 },
  channelItem: { paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.line },
  channelText: { color: c.text, fontSize: 13 },
  hero: { minHeight: 184, backgroundColor: '#282445', borderRadius: 16, marginBottom: 24,
    overflow: 'hidden', flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#443c70' },
  heroAccent: { width: 6, alignSelf: 'stretch', backgroundColor: c.accent },
  heroCopy: { flex: 1, paddingVertical: 24, paddingLeft: 26, paddingRight: 8 },
  heroEyebrow: { color: c.soft, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 8 },
  heroTitle: { color: c.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.8 },
  heroMeta: { color: '#cbc6e5', fontSize: 12, marginTop: 6, marginBottom: 16 },
  heroPlay: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: c.accent, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9 },
  heroPlayDisabled: { opacity: 0.5 },
  heroPlayText: { color: '#1b1730', fontSize: 12, fontWeight: '800' },
  heroShuffle: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 10,
    paddingHorizontal: 8, paddingVertical: 5 },
  heroArt: { width: 150, alignItems: 'center', justifyContent: 'center' },
  heroRecord: { width: 126, height: 126, borderRadius: 63, backgroundColor: '#17172c',
    borderWidth: 8, borderColor: '#3d3765', alignItems: 'center', justifyContent: 'center' },
  heroRecordInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#6554aa',
    borderWidth: 7, borderColor: '#8270bb', alignItems: 'center', justifyContent: 'center' },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  toolbarCompact: { flexWrap: 'wrap', gap: 12 },
  toolbarActions: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  toolbarActionsCompact: { width: '100%' },
  syncButton: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12,
    backgroundColor: c.raised, borderRadius: 9, borderWidth: 1, borderColor: c.line },
  syncButtonDisabled: { opacity: 0.5 },
  syncButtonText: { color: c.soft, fontSize: 12, fontWeight: '700' },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, width: 240, height: 36,
    backgroundColor: c.panel, borderColor: c.line, borderWidth: 1, borderRadius: 9, paddingHorizontal: 12 },
  searchField: { flex: 1, color: c.text, paddingVertical: 4, fontSize: 12 },
  section: { color: c.text, fontSize: 18, fontWeight: '800' },
  sectionSub: { color: c.muted, fontSize: 11, marginTop: 2 },
  searchCompact: { flex: 1 },
  filterBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 12 },
  artistFilter: { color: c.text, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line,
    borderRadius: 18, width: 165, paddingHorizontal: 11, paddingVertical: 5, fontSize: 11 },
  filterChip: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, borderRadius: 18,
    paddingHorizontal: 11, paddingVertical: 6, maxWidth: 220 },
  filterText: { color: c.soft, fontSize: 11, fontWeight: '600' },
  tableHead: { flexDirection: 'row', alignItems: 'center', height: 32, borderBottomWidth: 1, borderBottomColor: c.line, marginBottom: 5 },
  tableNumber: { color: '#7b899f', width: 30, fontSize: 10, paddingLeft: 10 },
  tableCover: { width: 50 },
  tableTitle: { color: '#7b899f', flex: 1, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  tableSize: { color: '#7b899f', width: 100, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  tableDuration: { color: '#7b899f', width: 52, fontSize: 10, fontWeight: '800', letterSpacing: 1, textAlign: 'right', paddingRight: 9 },
  tableActions: { width: 108 },
  tableQueueActions: { width: 138 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, paddingHorizontal: 9, borderRadius: 8, marginBottom: 2 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  rowActions: { minWidth: 108, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  dragHandle: { width: 30, height: 32, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  rowAction: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  rowActionDisabled: { opacity: 0.35 },
  selected: { backgroundColor: '#27283f' },
  unavailableRow: { opacity: 0.45 },
  activeRowText: { color: c.soft },
  rowNumber: { color: c.muted, width: 22, fontSize: 11 },
  cover: { width: 40, height: 40, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  coverLarge: { width: 48, height: 48, borderRadius: 9 },
  coverGlyph: { color: '#ffffff', fontSize: 20, fontWeight: '800', opacity: 0.9 },
  coverGlyphLarge: { fontSize: 24 },
  trackText: { flex: 1, minWidth: 0 },
  trackTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  trackArtist: { color: c.muted, fontSize: 11, marginTop: 3 },
  rowSize: { color: c.muted, fontSize: 11, width: 100 },
  rowDuration: { color: c.muted, fontSize: 11, width: 43, textAlign: 'right' },
  emptyCard: { alignItems: 'center', padding: 36, marginTop: 18, borderWidth: 1, borderColor: c.line, borderRadius: 14, backgroundColor: c.panel },
  emptyTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  empty: { color: c.muted, fontSize: 12, marginTop: 5, textAlign: 'center' },
  playerBar: { height: 100, paddingHorizontal: 22, backgroundColor: c.panel, borderTopWidth: 1,
    borderColor: c.line, flexDirection: 'row', alignItems: 'center' },
  playerBarCompact: { height: 145, flexDirection: 'column', alignItems: 'stretch', paddingVertical: 10 },
  nowPlaying: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  playerTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  playerCenter: { flex: 1.2 },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 1 },
  progressTrack: { flex: 1, height: 5, backgroundColor: c.raised, borderRadius: 3 },
  progressFill: { height: 5, backgroundColor: c.accent, borderRadius: 3 },
  time: { color: c.muted, fontSize: 10, width: 30 },
  transportButton: { paddingHorizontal: 17, paddingVertical: 9 },
  repeatButton: { position: 'absolute', left: 0, paddingHorizontal: 10, paddingVertical: 8 },
  disabledPlay: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.raised,
    alignItems: 'center', justifyContent: 'center' },
  enabledPlay: { backgroundColor: c.accent },
  playerRight: { flex: 1, alignItems: 'flex-end' },
  playerRightLabel: { color: c.text, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  volumeRow: { width: 150, flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 10 },
  volumeTrack: { flex: 1, height: 5, backgroundColor: c.raised, borderRadius: 3 },
  volumeFill: { height: 5, backgroundColor: c.accent, borderRadius: 3 },
  volumeValue: { color: c.muted, fontSize: 10, width: 29, textAlign: 'right' },
});
