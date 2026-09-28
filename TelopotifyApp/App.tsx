import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, FlatList, Image, Linking, NativeModules, PanResponder, Platform, Pressable as NativePressable,
  ScrollView, StatusBar, StyleSheet, Text, TextInput, useWindowDimensions, View, type ViewStyle,
} from 'react-native';
import { searchTracks, type Track } from './src/core/library';
import { createQueue, currentTrackId, moveQueueTrack,
  moveQueueTrackTo, playNextInQueue, removeFromQueue, stepPlayableQueue,
  shuffleUpcoming, type QueueState } from './src/core/queue';
import { discoverTracks, fileType, type DurationFilter, type SortOrder } from './src/core/discovery';
import { Icon, type IconName } from './src/components/Icon';

const c = {
  bg: '#080b10', panel: '#111720', raised: '#1c2633', line: '#28323d',
  text: '#f5f6f4', muted: '#a1aab4', accent: '#ff9b46', soft: '#ffc18b',
};

const AnimatedPressable = Animated.createAnimatedComponent(NativePressable);
function Pressable({ style, disabled, hoverAnimation = true, onHoverIn, onHoverOut, onPressIn, onPressOut, ...props }:
  React.ComponentProps<typeof NativePressable> & { hoverAnimation?: boolean }) {
  const motion = useRef(new Animated.Value(0)).current;
  const hovered = useRef(false);
  const animate = (value: number) => Animated.timing(motion, {
    toValue: value, duration: 140, useNativeDriver: true,
  }).start();
  return <AnimatedPressable {...props} disabled={disabled}
    onHoverIn={event => { hovered.current = true; if (hoverAnimation && !disabled) animate(1); onHoverIn?.(event); }}
    onHoverOut={event => { hovered.current = false; if (hoverAnimation) animate(0); onHoverOut?.(event); }}
    onPressIn={event => { if (hoverAnimation && !disabled) animate(1.5); onPressIn?.(event); }}
    onPressOut={event => { if (hoverAnimation) animate(hovered.current ? 1 : 0); onPressOut?.(event); }}
    style={[style as ViewStyle, { cursor: disabled ? 'auto' : 'pointer' } as ViewStyle,
      hoverAnimation && { opacity: motion.interpolate({ inputRange: [0, 1, 1.5], outputRange: [1, 0.88, 0.72] }),
        transform: [{ scale: motion.interpolate({ inputRange: [0, 1, 1.5], outputRange: [1, 1.012, 0.985] }) }] }]} />;
}

const DISCOVERY_URL = 'http://127.0.0.1:43127/bootstrap';
const BRIDGE_BASE = 'http://127.0.0.1:43127';

function clock(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function size(bytes: number) { return `${(bytes / 1_000_000).toFixed(1)} MB`; }
const coverColors = ['#173b58', '#24485d', '#514333', '#234b54', '#36495b'];
type ArtworkContextValue = { bridge: Bridge | null; overrides: Record<string, string>;
  albums: Record<string, string> };
const ArtworkContext = React.createContext<ArtworkContextValue>({ bridge: null, overrides: {}, albums: {} });

function ArtworkImage({ track }: { track?: Track }) {
  const { bridge, overrides, albums } = React.useContext(ArtworkContext);
  const uri = track ? overrides[track.id] || (bridge ?
    `${bridge.base}/artwork/${track.messageId}?token=${encodeURIComponent(bridge.token)}&album=${encodeURIComponent(albums[track.id] ?? '')}` : '') : '';
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri, bridge?.online]);
  return uri && !failed ? <Image source={{ uri }} resizeMode="cover" style={s.coverImage}
    onError={() => setFailed(true)} /> : null;
}

function Cover({ track, large = false }: { track?: Track; large?: boolean }) {
  const index = track ? Number(track.messageId) % coverColors.length : 0;
  return <View style={[s.cover, large && s.coverLarge, { backgroundColor: coverColors[index] }]}>
    {track?.title ? <Text style={[s.coverGlyph, large && s.coverGlyphLarge]}>{track.title.slice(0, 1).toUpperCase()}</Text> :
      <Icon name="music" size={large ? 24 : 20} />}
    <ArtworkImage track={track} />
  </View>;
}

type Bridge = { base: string; token: string; online: boolean };
type BridgeStatus = { authenticated: boolean; online: boolean; step: string; error: string;
  channel: string; trackCount: number; selected: boolean; indexing: boolean;
  syncing: boolean; catalogRevision: number; lastSyncedAt: string | null; syncError: string;
  cache: CacheStats; offline?: OfflineStats | null; unavailableTrackIds: number[] };
type CacheStats = { bytes: number; limitBytes: number; chunks: number };
type OfflineStats = { bytes: number; limitBytes: number; pinnedIds: string[];
  job: { total: number; completed: number; currentId: string | null; error: string } | null };
type ChannelChoice = { index: number; title: string; selected: boolean };
type LibraryResponse = { channel: string; channelId: string | null; online: boolean; catalogRevision: number;
  unavailableTrackIds: number[]; tracks: Array<{
  messageId: number; title: string; artist: string; durationSeconds: number | null;
  fileSize: number; mimeType: string }> };
type Playlist = { id: string; name: string; trackIds: string[] };
type CollectionsResponse = { channelId: string; favorites: string[]; playlists: Playlist[]; recentTrackIds?: string[];
  albumOverrides?: Record<string, string>; coverOverrides?: Record<string, string>;
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
  const [offline, setOffline] = useState<OfflineStats>({ bytes: 0, limitBytes: 512 * 1048576,
    pinnedIds: [], job: null });
  const [offlineError, setOfflineError] = useState('');
  const [speed, setSpeed] = useState(1);
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [unavailableTrackIds, setUnavailableTrackIds] = useState<Set<string>>(() => new Set());
  const [playbackNotice, setPlaybackNotice] = useState('');
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState('stopped');
  const [position, setPosition] = useState(0);
  const [nativeDuration, setNativeDuration] = useState(0);
  const [progressWidth, setProgressWidth] = useState(1);
  const [volume, setVolume] = useState(1);
  const [volumeWidth, setVolumeWidth] = useState(1);
  const endedHandled = useRef(false);
  const [page, setPage] = useState<'home' | 'library' | 'artists' | 'albums' |
    'favorites' | 'playlists' | 'queue' | 'recent' | 'nowPlaying'>('home');
  const pageMotion = useRef(new Animated.Value(1)).current;
  const initialPage = useRef(true);
  useEffect(() => {
    if (initialPage.current) { initialPage.current = false; return; }
    pageMotion.setValue(0);
    Animated.timing(pageMotion, { toValue: 1, duration: 190, useNativeDriver: true }).start();
  }, [page, pageMotion]);
  const [queue, setQueue] = useState(() => createQueue([]));
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recentTrackIds, setRecentTrackIds] = useState<string[]>([]);
  const [albumOverrides, setAlbumOverrides] = useState<Record<string, string>>({});
  const [coverOverrides, setCoverOverrides] = useState<Record<string, string>>({});
  const [coverEditOpen, setCoverEditOpen] = useState(false);
  const [coverEditUrl, setCoverEditUrl] = useState('');
  const [coverError, setCoverError] = useState('');
  const [activeArtist, setActiveArtist] = useState('');
  const [activeAlbum, setActiveAlbum] = useState('');
  const [groupQuery, setGroupQuery] = useState('');
  const [albumEditTrackId, setAlbumEditTrackId] = useState('');
  const [albumEditName, setAlbumEditName] = useState('');
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
  const artistGroups = useMemo(() => {
    const grouped = new Map<string, Track[]>();
    for (const track of tracks) {
      if (!grouped.has(track.artist)) grouped.set(track.artist, []);
      grouped.get(track.artist)!.push(track);
    }
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tracks]);
  const albumGroups = useMemo(() => {
    const grouped = new Map<string, Track[]>();
    for (const track of tracks) {
      const album = albumOverrides[track.id] || 'Unsorted tracks';
      if (!grouped.has(album)) grouped.set(album, []);
      grouped.get(album)!.push(track);
    }
    return [...grouped.entries()].sort((a, b) => a[0] === 'Unsorted tracks' ? 1 :
      b[0] === 'Unsorted tracks' ? -1 : a[0].localeCompare(b[0]));
  }, [tracks, albumOverrides]);
  const selected = tracks.find(track => track.id === currentTrackId(queue));
  const homeTrack = tracks.find(track => track.id === recentTrackIds[0]) ?? tracks[0];
  const pinnedKey = offline.pinnedIds.join(',');
  const pinnedIds = useMemo(() => new Set(pinnedKey ? pinnedKey.split(',') : []), [pinnedKey]);
  const playableTracks = useMemo(() => tracks.filter(track =>
    (pinnedIds.has(track.id) || !unavailableTrackIds.has(track.id)) &&
    (bridge?.online || pinnedIds.has(track.id))),
    [tracks, unavailableTrackIds, bridge?.online, pinnedIds]);
  const duration = nativeDuration || selected?.durationSeconds || 0;
  const items = useMemo(() => page === 'home' ? tracks.slice(0, 12) :
    page === 'library' ? discovered : page === 'favorites' ?
    discovered.filter(track => favorites.includes(track.id)) :
    page === 'playlists' ? (activePlaylist?.trackIds ?? []).map(id => tracks.find(track => track.id === id)!).filter(Boolean) :
    page === 'recent' ? recentTrackIds.map(id => tracks.find(track => track.id === id)!).filter(Boolean) :
    page === 'artists' ? activeArtist ? tracks.filter(track => track.artist === activeArtist) : [] :
    page === 'albums' ? activeAlbum ? tracks.filter(track =>
      (albumOverrides[track.id] || 'Unsorted tracks') === activeAlbum) : [] :
    page === 'nowPlaying' ? queue.trackIds.slice(queue.currentIndex + 1)
      .map(id => tracks.find(track => track.id === id)!).filter(Boolean) :
    queue.trackIds.map(id => tracks.find(track => track.id === id)!).filter(Boolean),
  [page, tracks, discovered, favorites, activePlaylist, recentTrackIds, activeArtist,
    activeAlbum, albumOverrides, queue.trackIds, queue.currentIndex]);
  const groupPage = (page === 'artists' && !activeArtist) || (page === 'albums' && !activeAlbum);
  const groupRows = useMemo(() => (page === 'artists' ? artistGroups : albumGroups)
    .filter(([name]) => name.toLocaleLowerCase().includes(groupQuery.trim().toLocaleLowerCase())),
  [page, artistGroups, albumGroups, groupQuery]);
  const pageRows: Array<Track | [string, Track[]]> = groupPage ? groupRows : items;

  const playTrack = useCallback(async (track: Track) => {
    if (!bridge || (!bridge.online && !pinnedIds.has(track.id))) return;
    const url = `${bridge.base}/audio/${track.messageId}?token=${encodeURIComponent(bridge.token)}`;
    try {
      if (Platform.OS === 'windows') {
        if (!NativeModules.TelopotifyAudio) throw new Error('Windows audio module is unavailable');
        NativeModules.TelopotifyAudio.play(url, track.title, track.artist);
        NativeModules.TelopotifyAudio.setSpeed?.(speed);
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
  }, [bridge, pinnedIds, speed]);

  useEffect(() => {
    if (Platform.OS !== 'windows' || !playingTrackId || !bridge) return;
    const refresh = () => {
      try {
        const audio = NativeModules.TelopotifyAudio;
        const available = new Set(tracks.filter(track => (bridge.online || pinnedIds.has(track.id)) &&
          (pinnedIds.has(track.id) || !unavailableTrackIds.has(track.id))).map(track => track.id));
        const command = Number(audio.takeMediaCommand?.() ?? 0);
        if (command === 3) {
          const changed = stepPlayableQueue(queue, available, 'next', true);
          const target = changed && tracks.find(track => track.id === currentTrackId(changed));
          if (changed && target) {
            setQueue(changed);
            setPlayingTrackId(target.id);
            setRecentTrackIds(current => [target.id, ...current.filter(id => id !== target.id)].slice(0, 50));
            setPosition(0);
            setNativeDuration(0);
            endedHandled.current = false;
          } else {
            audio.stop();
            setPlayingTrackId(null);
            setPlaybackStatus('stopped');
          }
          return;
        }
        if (command === 1 || command === 2) {
          const changed = stepPlayableQueue(queue, available, command === 1 ? 'next' : 'previous');
          const target = changed && tracks.find(track => track.id === currentTrackId(changed));
          if (changed && target && target.id !== playingTrackId) { setQueue(changed); playTrack(target); return; }
        }
        const status = String(audio.getStatus());
        if (status === 'ended' && !endedHandled.current) {
          endedHandled.current = true;
          const next = stepPlayableQueue(queue, available, 'next', true);
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
  }, [playingTrackId, bridge, queue, tracks, playTrack, pinnedIds, unavailableTrackIds]);

  useEffect(() => {
    if (Platform.OS !== 'windows' || !bridge || !playingTrackId ||
        currentTrackId(queue) !== playingTrackId) return;
    const available = new Set(tracks.filter(track => (bridge.online || pinnedIds.has(track.id)) &&
      (pinnedIds.has(track.id) || !unavailableTrackIds.has(track.id))).map(track => track.id));
    const next = queue.repeat === 'one' ? null : stepPlayableQueue(queue, available, 'next', true);
    const target = next && tracks.find(track => track.id === currentTrackId(next));
    const url = target ? `${bridge.base}/audio/${target.messageId}?token=${encodeURIComponent(bridge.token)}` : '';
    NativeModules.TelopotifyAudio?.setNext?.(url, target?.title ?? '', target?.artist ?? '');
  }, [queue, playingTrackId, bridge, tracks, pinnedIds, unavailableTrackIds]);

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
        const available = new Set(library.filter(track => !unavailableIds.has(track.id) || pinnedIds.has(track.id)).map(track => track.id));
        const trackIds = current.trackIds.filter(id => available.has(id));
        const currentId = currentTrackId(current);
        return { ...current, trackIds, currentIndex: Math.max(0, trackIds.indexOf(currentId ?? '')) };
      });
    } else {
      setCollectionsReady(false);
      setCollectionError('');
      setFavorites([]);
      setRecentTrackIds([]);
      setAlbumOverrides({});
      setCoverOverrides({});
      setArtistFilter('');
      setDurationFilter('any');
      setTypeFilter('All types');
      setSortOrder('newest');
      setPlaylists([]);
      setPlaylistPickerTrackId(null);
      setQueue(createQueue(library.filter(track => !unavailableIds.has(track.id) || pinnedIds.has(track.id)).map(track => track.id)));
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
        const available = new Set(library.filter(track => !unavailableIds.has(track.id) || pinnedIds.has(track.id)).map(track => track.id));
        const trackIds = saved.queue.trackIds.filter(id => available.has(id));
        setFavorites(saved.favorites);
        setRecentTrackIds((saved.recentTrackIds ?? []).filter(id => library.some(track => track.id === id)));
        setAlbumOverrides(saved.albumOverrides ?? {});
        setCoverOverrides(saved.coverOverrides ?? {});
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
  }, [pinnedIds]);

  useEffect(() => {
    if (!collectionsReady || !bridge || !loadedChannel.current) return;
    const channelId = loadedChannel.current;
    const snapshot = { channelId, favorites, playlists, recentTrackIds, albumOverrides, coverOverrides,
      queue: { trackIds: queue.trackIds, currentTrackId: currentTrackId(queue), repeat: queue.repeat } };
    const timer = setTimeout(() => {
      saveTail.current = saveTail.current.catch(() => {}).then(() =>
        bridgeRequest(bridge, '/collections', snapshot));
      saveTail.current.catch(error => setCollectionError(error instanceof Error ? error.message :
        'Could not save collections'));
    }, 350);
    return () => clearTimeout(timer);
  }, [bridge, collectionsReady, favorites, playlists, queue, recentTrackIds, albumOverrides, coverOverrides]);

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
    if (data.cache) setCache(current => current.bytes === data.cache.bytes &&
      current.limitBytes === data.cache.limitBytes && current.chunks === data.cache.chunks ? current : data.cache);
    if (data.offline) setOffline(current => JSON.stringify(current) === JSON.stringify(data.offline) ?
      current : data.offline!);
    const savedIds = new Set(data.offline?.pinnedIds ?? []);
    const missing = new Set((data.unavailableTrackIds ?? []).map(String));
    setUnavailableTrackIds(current => current.size === missing.size &&
      [...current].every(id => missing.has(id)) ? current : missing);
    if (missing.size) {
      setQueue(current => {
        let next = current;
        for (const id of current.trackIds) if (missing.has(id) && !savedIds.has(id)) next = removeFromQueue(next, id);
        return next;
      });
      if (playingTrackId && missing.has(playingTrackId) && !savedIds.has(playingTrackId)) {
        if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.stop();
        setPlayingTrackId(null);
        setPlaybackStatus('stopped');
        setPlaybackNotice('This song is no longer available in Telegram. Choose another song.');
      }
    }
    if (data.authenticated && !data.selected) await loadChannels(connection);
    if (data.online && (!lastOnline.current || data.catalogRevision !== loadedRevision.current)) {
      await loadLibrary(connection);
      setPlaybackNotice('');
    }
    if (!data.online) {
      if (lastOnline.current && (!playingTrackId || !savedIds.has(playingTrackId))) {
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

  async function retryConnection() {
    if (!bridge || reconnectBusy) return;
    setReconnectBusy(true);
    setPlaybackNotice('Reconnecting to Telegram…');
    try {
      await bridgeRequest(bridge, '/reconnect', {});
      await refreshStatus(bridge);
      if (lastOnline.current) {
        setPlaybackNotice('');
      } else {
        setPlaybackNotice('Waiting for Telegram. The saved session will retry automatically.');
      }
    } catch (error) {
      setPlaybackNotice(error instanceof Error ? error.message : 'Could not reconnect to Telegram');
    } finally { setReconnectBusy(false); }
  }

  async function pinSongs(songIds: string[]) {
    if (!bridge || !bridge.online) return;
    setOfflineError('');
    try {
      const result = await bridgeRequest<OfflineStats>(bridge, '/offline/pin', {
        trackIds: songIds.map(Number),
      });
      setOffline(result);
    } catch (error) { setOfflineError(error instanceof Error ? error.message : 'Could not save songs offline'); }
  }

  async function unpinSongs(songIds: string[]) {
    if (!bridge) return;
    setOfflineError('');
    try {
      setOffline(await bridgeRequest<OfflineStats>(bridge, '/offline/unpin', {
        trackIds: songIds.map(String),
      }));
    } catch (error) { setOfflineError(error instanceof Error ? error.message : 'Could not remove offline songs'); }
  }

  async function cycleOfflineLimit() {
    if (!bridge) return;
    const limits = [128, 512, 1024, 2048];
    const current = Math.round(offline.limitBytes / 1048576);
    const next = limits[(limits.indexOf(current) + 1) % limits.length];
    setOfflineError('');
    try { setOffline(await bridgeRequest<OfflineStats>(bridge, '/offline/limit', {
      limitBytes: next * 1048576,
    })); }
    catch (error) { setOfflineError(error instanceof Error ? error.message : 'Could not change storage limit'); }
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
    if (!bridge) return;
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
      setAlbumOverrides({});
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
    if (!selected || !bridge || (!bridge.online && !pinnedIds.has(selected.id))) return;
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
    const changed = stepPlayableQueue(queue, new Set(playableTracks.map(track => track.id)), direction);
    if (!changed) return;
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

  function cycleSpeed() {
    const rates = [1, 1.25, 1.5, 2, 0.75];
    const next = rates[(rates.indexOf(speed) + 1) % rates.length];
    setSpeed(next);
    if (Platform.OS === 'windows') NativeModules.TelopotifyAudio?.setSpeed?.(next);
  }

  function cycleSleepTimer() {
    const minutes = sleepUntil ? Math.ceil((sleepUntil - Date.now()) / 60000) : 0;
    const next = minutes <= 0 ? 15 : minutes <= 15 ? 30 : minutes <= 30 ? 60 : 0;
    setSleepUntil(next ? Date.now() + next * 60000 : null);
    setSleepRemaining(next * 60);
  }

  function saveAlbumLabel() {
    if (!albumEditTrackId) return;
    const name = albumEditName.trim();
    if (name.length > 100) { setCollectionError('Album names can be up to 100 characters.'); return; }
    setAlbumOverrides(current => {
      const next = { ...current };
      if (name) next[albumEditTrackId] = name;
      else delete next[albumEditTrackId];
      return next;
    });
    setAlbumEditTrackId('');
    setAlbumEditName('');
  }

  function saveCoverUrl() {
    if (!selected) return;
    const url = coverEditUrl.trim();
    if (url && (url.length > 1000 || !/^https:\/\/[^\s]+$/i.test(url))) {
      setCoverError('Use an HTTPS image URL, or leave the field blank to restore automatic artwork.');
      return;
    }
    setCoverOverrides(current => {
      const next = { ...current };
      if (url) next[selected.id] = url;
      else delete next[selected.id];
      return next;
    });
    setCoverError('');
    setCoverEditOpen(false);
  }

  useEffect(() => {
    if (!sleepUntil) return;
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((sleepUntil - Date.now()) / 1000));
      setSleepRemaining(remaining);
      if (remaining === 0) {
        NativeModules.TelopotifyAudio?.pause?.();
        setPaused(true);
        setSleepUntil(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sleepUntil]);

  const online = Boolean(bridge?.online);
  const canPlay = online || pinnedIds.size > 0;
  const offlineBusy = !!offline.job && !offline.job.error;
  const showPause = playingTrackId === selected?.id && !paused &&
    ['opening', 'buffering', 'playing'].includes(playbackStatus);
  const currentLabel = online ? 'Ready to stream' : bridge ? 'Telegram offline' :
    connectionStatus.startsWith('Unable') ? 'Connection issue' : 'Connecting';
  const pageTitle = page === 'home' ? 'Good listening' : page === 'library' ? 'All tracks' :
    page === 'artists' ? activeArtist || 'Artists' : page === 'albums' ? activeAlbum || 'Albums' :
    page === 'nowPlaying' ? 'Now playing' : page === 'favorites' ? 'Liked songs' :
    page === 'playlists' ? 'Playlists' : page === 'recent' ? 'Recently played' : 'Play queue';

  return <ArtworkContext.Provider value={{ bridge, overrides: coverOverrides, albums: albumOverrides }}><View style={s.root}>
    <StatusBar barStyle="light-content" backgroundColor={c.bg} />
    <View style={s.body}>
      {wide && <View style={s.sidebar}>
        <View style={s.brandRow}><Image source={require('./assets/telopotify-logo.png')} style={s.brandMark} />
          <View><Text style={s.brand}>telopotify</Text><Text style={s.brandTag}>TELEGRAM MUSIC</Text></View></View>
        <Text style={s.navCaption}>DISCOVER</Text>
        <Nav icon="home" label="Home" active={page === 'home'} onPress={() => setPage('home')} />
        <Nav icon="library" label="Tracks" active={page === 'library'} onPress={() => setPage('library')} />
        <Nav icon="artist" label="Artists" active={page === 'artists'} onPress={() => { setActiveArtist(''); setPage('artists'); }} />
        <Nav icon="album" label="Albums" active={page === 'albums'} onPress={() => { setActiveAlbum(''); setPage('albums'); }} />
        <Nav icon="favorite" label="Favorites" active={page === 'favorites'} onPress={() => setPage('favorites')} />
        <Nav icon="playlist" label="Playlists" active={page === 'playlists'} onPress={() => setPage('playlists')} />
        <Nav icon="queue" label="Queue" active={page === 'queue'} onPress={() => setPage('queue')} />
        <Nav icon="recent" label="Recently played" active={page === 'recent'} onPress={() => setPage('recent')} />
        <Nav icon="music" label="Now playing" active={page === 'nowPlaying'} onPress={() => setPage('nowPlaying')} />
        <View style={s.sidebarDivider} />
        <Text style={s.navCaption}>YOUR COLLECTION</Text>
        <View style={s.collectionCard}><View style={s.collectionIcon}><Icon name="music" size={18} /></View>
          <View style={s.trackText}><Text numberOfLines={1} style={s.collectionTitle}>{channelName || 'Telegram channel'}</Text>
            <Text style={s.collectionCount}>{tracks.length} songs</Text></View></View>
        <View style={s.sidebarBottom}>
          <View style={s.statusRow}><View style={[s.statusDot, !online && s.statusDotIdle]} />
            <Text style={s.statusText}>{currentLabel}</Text></View>
          <Text style={s.connection} numberOfLines={2}>{connectionStatus}</Text>
        </View>
      </View>}
      <Animated.View style={[s.main, { opacity: pageMotion,
        transform: [{ translateY: pageMotion.interpolate({ inputRange: [0, 1], outputRange: [7, 0] }) }] }]}>
      <FlatList<Track | [string, Track[]]>
        key={`${page}:${activeArtist}:${activeAlbum}`}
        style={s.pageScroll} contentContainerStyle={s.pageScrollContent}
        keyboardShouldPersistTaps="handled" data={pageRows}
        keyExtractor={item => Array.isArray(item) ? item[0] : item.id}
          renderItem={({ item, index }) => Array.isArray(item) ? <GroupRow
            icon={page === 'artists' ? 'artist' : 'album'} name={item[0]} count={item[1].length}
            track={item[1][0]} onPress={() => page === 'artists' ?
              setActiveArtist(item[0]) : setActiveAlbum(item[0])} /> : <View
            style={[s.row, selected?.id === item.id && s.selected, unavailableTrackIds.has(item.id) && s.unavailableRow]}>
            <Pressable accessibilityRole="button"
              accessibilityLabel={unavailableTrackIds.has(item.id) && !pinnedIds.has(item.id) ? `${item.title} unavailable` : `Play ${item.title}`}
              disabled={!playableTracks.some(track => track.id === item.id)}
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
                <Text numberOfLines={1} style={s.trackArtist}>{item.artist}{pinnedIds.has(item.id) ? ' · Offline' :
                  unavailableTrackIds.has(item.id) ? ' · Unavailable' : ''}</Text>
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
                disabled={!playableTracks.some(track => track.id === item.id)} onPress={() => setQueue(current => playNextInQueue(current, item.id))} />}
              {page !== 'queue' && <RowAction icon={pinnedIds.has(item.id) ? 'offline' : 'download'}
                label={`${pinnedIds.has(item.id) ? 'Remove' : 'Save'} ${item.title} offline`}
                disabled={offlineBusy || (!online && !pinnedIds.has(item.id))}
                active={pinnedIds.has(item.id)} onPress={() => pinnedIds.has(item.id) ?
                  unpinSongs([item.id]) : pinSongs([item.id])} />}
              {page === 'albums' && <RowAction icon="album" label={`Set album for ${item.title}`}
                onPress={() => { setAlbumEditTrackId(item.id); setAlbumEditName(albumOverrides[item.id] ?? ''); }} />}
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
          ListEmptyComponent={groupPage ? <Text style={s.empty}>No matching {page} yet.</Text> : <View style={s.emptyCard}><Icon name="music" size={28} color={c.accent} />
            <Text style={s.emptyTitle}>{query && (page === 'library' || page === 'favorites') ? 'No songs found' :
              (page === 'library' && tracks.length || page === 'favorites' && favorites.length) ? 'No matching songs' :
              page === 'queue' ? 'Your queue is empty' : page === 'favorites' ? 'No favorites yet' :
              page === 'playlists' ? 'This playlist is empty' : page === 'recent' ? 'Nothing played yet' :
              'Your songs will appear here'}</Text>
            <Text style={s.empty}>{page === 'favorites' ? 'Use the star beside a song to save it here.' :
              page === 'playlists' ? 'Add songs using the playlist icon in your library.' :
              page === 'queue' ? 'Add songs from your library or a playlist.' :
              page === 'recent' ? 'Songs you play will show up here.' :
              page === 'library' && tracks.length ?
                'Try changing the search or filters.' : connectionStatus}</Text></View>}
        ListHeaderComponent={<>

        {!wide && <View style={s.compactNav}>
          <View style={s.compactBrandRow}><Image source={require('./assets/telopotify-logo.png')}
            style={s.compactLogo} /><Text style={s.compactBrand}>telopotify</Text></View>
          <Nav icon="home" label="Home" active={page === 'home'} onPress={() => setPage('home')} />
          <Nav icon="library" label="Tracks" active={page === 'library'} onPress={() => setPage('library')} />
          <Nav icon="artist" label="Artists" active={page === 'artists'} onPress={() => { setActiveArtist(''); setPage('artists'); }} />
          <Nav icon="album" label="Albums" active={page === 'albums'} onPress={() => { setActiveAlbum(''); setPage('albums'); }} />
          <Nav icon="favorite" label="Favorites" active={page === 'favorites'} onPress={() => setPage('favorites')} />
          <Nav icon="playlist" label="Playlists" active={page === 'playlists'} onPress={() => setPage('playlists')} />
          <Nav icon="queue" label="Queue" active={page === 'queue'} onPress={() => setPage('queue')} />
          <Nav icon="recent" label="Recent" active={page === 'recent'} onPress={() => setPage('recent')} />
          <Nav icon="music" label="Playing" active={page === 'nowPlaying'} onPress={() => setPage('nowPlaying')} />
        </View>}
        <View style={s.topLine}><Text style={s.breadcrumb}>MY MUSIC  /  {page.toUpperCase()}</Text>
          <View style={s.topStatus}><View style={[s.statusDot, !online && s.statusDotIdle]} />
            <Text style={s.topStatusText}>{currentLabel}</Text></View></View>
        <Text style={s.heading}>{pageTitle}</Text>
        <Text style={s.subtitle}>{page === 'home' ? 'Your channel, arranged for the moment.' :
          page === 'library' ? 'Every song from your channel, ready when you are.' :
          page === 'artists' ? 'Browse by artist.' :
          page === 'albums' ? 'Group songs into albums on this device.' :
          page === 'nowPlaying' ? 'Stay with the music.' :
          page === 'favorites' ? 'The songs you keep coming back to.' :
          page === 'playlists' ? 'Build your own collections from the channel.' :
          'The songs lined up for your listening session.'}</Text>
        {(page === 'artists' && activeArtist || page === 'albums' && activeAlbum) &&
          <Pressable accessibilityRole="button" accessibilityLabel="Back to groups"
            onPress={() => page === 'artists' ? setActiveArtist('') : setActiveAlbum('')}
            style={s.backLink}><Icon name="previous" size={14} color={c.soft} />
            <Text style={s.backLinkText}>All {page}</Text></Pressable>}
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
        {bridge && tracks.length > 0 && !online && <View style={s.connectionRecovery}>
          <View style={s.recoveryCopy}><Text style={s.recoveryTitle}>Telegram is offline</Text>
            <Text style={s.recoveryDetail}>Your saved session is still here. Reconnect when your network is available.</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Reconnect to Telegram"
            disabled={reconnectBusy} onPress={retryConnection} style={s.recoveryAction}>
            <Icon name="sync" size={15} color={c.soft} />
            <Text style={s.alertActionText}>{reconnectBusy ? 'Reconnecting' : 'Reconnect'}</Text>
          </Pressable>
        </View>}
        {bridge && tracks.length > 0 && page === 'library' && <View style={s.storageRow}>
          <View style={s.storageCell}><CacheInfo stats={cache} busy={cacheBusy} onClear={clearCache} /></View>
          <View style={s.storageCell}><OfflineInfo stats={offline} error={offlineError}
            onChangeLimit={cycleOfflineLimit} /></View>
        </View>}
        {!!(playbackNotice || playbackStatus.startsWith('error:')) && <View style={s.playbackAlert}>
          <View style={s.alertCopy}><Text style={s.alertTitle}>Playback interrupted</Text>
            <Text style={s.alertDetail}>{playbackNotice || 'Could not stream this song. Check the connection and try again.'}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry playback"
            disabled={reconnectBusy || (!selected && online)}
            onPress={() => online ? selected && playTrack(selected) : retryConnection()} style={s.alertAction}>
            <Icon name="sync" size={15} color={c.soft} /><Text style={s.alertActionText}>
              {reconnectBusy ? 'Reconnecting' : online ? 'Retry' : 'Reconnect'}</Text>
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
              disabled={!activePlaylist.trackIds.some(id => playableTracks.some(track => track.id === id))}
              onPress={() => playSongs(activePlaylist.trackIds)} style={[s.smallSecondary,
                !activePlaylist.trackIds.length && s.syncButtonDisabled]}>
              <Icon name="play" size={15} color={c.soft} /><Text style={s.smallSecondaryText}>Play</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Save playlist ${activePlaylist.name} offline`}
              disabled={!online || offlineBusy || !activePlaylist.trackIds.some(id => !pinnedIds.has(id))}
              onPress={() => pinSongs(activePlaylist.trackIds.filter(id => !pinnedIds.has(id)))}
              style={[s.smallSecondary, (!online || offlineBusy) && s.syncButtonDisabled]}>
              <Icon name="download" size={15} color={c.soft} /><Text style={s.smallSecondaryText}>Save offline</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove playlist ${activePlaylist.name} offline`}
              disabled={offlineBusy || !activePlaylist.trackIds.some(id => pinnedIds.has(id))}
              onPress={() => unpinSongs(activePlaylist.trackIds.filter(id => pinnedIds.has(id)))}
              style={s.smallSecondary}><Icon name="remove" size={15} color={c.soft} />
              <Text style={s.smallSecondaryText}>Remove downloads</Text></Pressable>
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
        {tracks.length > 0 && page === 'home' && <View style={s.hero}>
          <View style={s.heroAccent} />
          <View style={s.heroCopy}><Text style={s.heroEyebrow}>FEATURED FROM YOUR CHANNEL</Text>
            <Text numberOfLines={2} style={s.heroTitle}>{homeTrack?.title || 'Your music'}</Text>
            <Text numberOfLines={1} style={s.heroMeta}>{homeTrack?.artist} · {tracks.length.toLocaleString()} songs in your channel</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Play library"
              disabled={!canPlay} onPress={() => homeTrack && playSongs(tracks.map(track => track.id), homeTrack.id)}
              style={[s.heroPlay, !canPlay && s.heroPlayDisabled]}><Icon name="play" size={15} color={c.bg} />
              <Text style={s.heroPlayText}>Listen now</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Shuffle library"
              disabled={!canPlay}
              onPress={() => playSongs(tracks.map(track => track.id), undefined, true)} style={s.heroShuffle}>
              <Icon name="shuffle" size={15} color={c.soft} /><Text style={s.syncButtonText}>Shuffle collection</Text>
            </Pressable>
          </View>{wide && <View style={s.heroArt}><RecordArt track={homeTrack} /></View>}
        </View>}
        {page === 'home' && artistGroups.length > 0 && <View style={s.homeShelf}>
          <View style={s.shelfHeading}><Text style={s.section}>Explore artists</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="View all artists"
              onPress={() => { setActiveArtist(''); setPage('artists'); }}>
              <Text style={s.shelfLink}>View all</Text></Pressable></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {artistGroups.slice().sort((a, b) => b[1].length - a[1].length).slice(0, 6)
              .map(([name, songs]) => <GroupCard key={name} icon="artist"
              name={name} count={songs.length} track={songs[0]} onPress={() => {
                setActiveArtist(name); setPage('artists');
              }} />)}
          </ScrollView>
        </View>}
        {page === 'nowPlaying' && <View style={[s.nowPage, !wide && s.nowPageCompact]}>
          <RecordArt track={selected} large />
          <View style={s.nowPageCopy}><Text style={s.heroEyebrow}>CURRENT TRACK</Text>
            <Text numberOfLines={2} style={s.nowPageTitle}>{selected?.title ?? 'Nothing playing yet'}</Text>
            <Text style={s.nowPageArtist}>{selected?.artist ?? 'Choose a song from your library'}</Text>
            <View style={s.nowPageButtons}>
              <Pressable accessibilityRole="button" accessibilityLabel="Previous song from now playing"
                onPress={() => changeTrack('previous')} style={s.transportButton}>
                <Icon name="previous" size={22} color={c.text} /></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Toggle playback from now playing"
                disabled={!selected} onPress={togglePlayback} style={s.heroPlay}>
                <Icon name={showPause ? 'pause' : 'play'} size={23} color={c.bg} /></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Next song from now playing"
                onPress={() => changeTrack('next')} style={s.transportButton}>
                <Icon name="next" size={22} color={c.text} /></Pressable>
            </View>
            <View style={s.progressRow}><Text style={s.time}>{clock(position)}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Seek on now playing page"
                onLayout={event => setProgressWidth(event.nativeEvent.layout.width)}
                onPress={event => seekTo(duration * event.nativeEvent.locationX / progressWidth)}
                style={s.progressTrack}><View style={[s.progressFill,
                  { width: `${duration ? Math.min(100, position / duration * 100) : 0}%` }]} /></Pressable>
              <Text style={s.time}>{clock(duration)}</Text></View>
            <Text style={s.nowPageMeta}>{albumOverrides[selected?.id ?? ''] || 'Album not set'} · {speed}× speed</Text>
            {selected && <Pressable accessibilityRole="button" accessibilityLabel="Edit current song cover"
              onPress={() => { setCoverEditUrl(coverOverrides[selected.id] ?? ''); setCoverError('');
                setCoverEditOpen(!coverEditOpen); }} style={s.coverEditButton}>
              <Text style={s.coverEditText}>Edit cover</Text></Pressable>}
            {selected && coverEditOpen && <View style={s.coverEditPanel}>
              <Text style={s.panelHelp}>Paste an HTTPS image URL. Leave it blank to use automatic artwork.</Text>
              <TextInput accessibilityLabel="Custom cover URL" placeholder="https://example.com/cover.jpg"
                placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false}
                value={coverEditUrl} onChangeText={setCoverEditUrl} style={s.coverEditInput} />
              {coverError ? <Text style={s.authError}>{coverError}</Text> : null}
              <Pressable accessibilityRole="button" accessibilityLabel="Save custom cover"
                onPress={saveCoverUrl} style={s.smallPrimary}><Text style={s.smallPrimaryText}>Save cover</Text></Pressable>
            </View>}
          </View>
        </View>}
        {page === 'albums' && !!albumEditTrackId && <View style={s.playlistPanel}>
          <Text style={s.panelEyebrow}>SET ALBUM FOR {tracks.find(track => track.id === albumEditTrackId)?.title.toUpperCase()}</Text>
          <View style={s.playlistCreateRow}>
            <TextInput accessibilityLabel="Album name" placeholder="Album name"
              placeholderTextColor={c.muted} value={albumEditName} onChangeText={setAlbumEditName}
              maxLength={100} style={[s.search, s.playlistInput]} />
            <Pressable accessibilityRole="button" accessibilityLabel="Save album name" onPress={saveAlbumLabel}
              style={s.smallPrimary}><Text style={s.smallPrimaryText}>Save</Text></Pressable>
          </View>
          <Text style={s.panelHelp}>Leave blank to move this song back to Unsorted tracks.</Text>
        </View>}
        {(page === 'artists' && !activeArtist || page === 'albums' && !activeAlbum) ?
          <><TextInput accessibilityLabel={`Search ${page}`} placeholder={`Search ${page}`}
            placeholderTextColor={c.muted} value={groupQuery} onChangeText={setGroupQuery}
            style={[s.search, s.groupSearch]} />
</> : <>
        <View style={[s.toolbar, !wide && s.toolbarCompact]}><View><Text style={s.section}>{page === 'library' ? 'All songs' :
          page === 'favorites' ? 'Liked songs' : page === 'playlists' ? activePlaylist?.name ?? 'Playlist songs' :
          page === 'recent' ? 'Your latest listens' : page === 'home' ? 'Fresh from your channel' :
          page === 'nowPlaying' ? 'Coming up' : page === 'artists' ? 'Songs by this artist' :
          page === 'albums' ? 'Album tracks' : 'Up next'}</Text>
          <Text style={s.sectionSub}>{items.length.toLocaleString()} tracks{(page === 'library' || page === 'favorites') && query ? ' found' : ''}{syncError ? ' · Sync will retry when Telegram is available.' : syncMessage ? ` · ${syncMessage}` : ''}</Text></View>
          <View style={[s.toolbarActions, !wide && s.toolbarActionsCompact]}>
            {page === 'library' && <Pressable accessibilityRole="button" accessibilityLabel="Sync new songs"
              disabled={!online || syncBusy || syncing} onPress={syncLibrary}
              style={[s.syncButton, (!online || syncBusy || syncing) && s.syncButtonDisabled]}>
              <Icon name="sync" size={15} color={c.soft} /><Text style={s.syncButtonText}>{syncBusy || syncing ? 'Syncing' : 'Sync'}</Text>
            </Pressable>}
            {(page === 'favorites' || page === 'playlists' || page === 'recent') && !!items.length && <Pressable
              accessibilityRole="button" accessibilityLabel="Play all shown songs" disabled={!canPlay}
              onPress={() => playSongs(items.map(track => track.id))}
              style={[s.syncButton, !canPlay && s.syncButtonDisabled]}><Icon name="play" size={15} color={c.soft} />
              <Text style={s.syncButtonText}>Play all</Text></Pressable>}
            {(page === 'favorites' || page === 'playlists' || page === 'recent') && !!items.length && <Pressable
              accessibilityRole="button" accessibilityLabel="Shuffle shown songs" disabled={!canPlay}
              onPress={() => playSongs(items.map(track => track.id), undefined, true)}
              style={[s.syncButton, !canPlay && s.syncButtonDisabled]}><Icon name="shuffle" size={15} color={c.soft} />
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

        </>}
        </>} />
      </Animated.View>
      {wide && width >= 1120 && page !== 'nowPlaying' && <View style={s.rightRail}>
        <View style={s.railHeading}><Text style={s.railTitle}>Now playing</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Open full now playing page"
            onPress={() => setPage('nowPlaying')}><Icon name="expand" size={17} color={c.soft} /></Pressable></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open now playing details"
          onPress={() => setPage('nowPlaying')} style={s.railArt}><RecordArt track={selected} /></Pressable>
        <Text numberOfLines={2} style={s.railSong}>{selected?.title || 'Choose a song'}</Text>
        <Text numberOfLines={1} style={s.railArtist}>{selected?.artist || channelName || 'Your music'}</Text>
        <View style={s.railDivider} />
        <View style={s.railHeading}><Text style={s.railTitle}>Up next</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Open queue"
            onPress={() => setPage('queue')}><Text style={s.shelfLink}>View all</Text></Pressable></View>
        <ScrollView style={s.railQueue}>
          {queue.trackIds.slice(queue.currentIndex + 1, queue.currentIndex + 10)
            .map(id => tracks.find(track => track.id === id)).filter((track): track is Track => !!track)
            .map(track => <Pressable key={track.id} accessibilityRole="button"
              accessibilityLabel={`Play upcoming ${track.title}`}
              onPress={() => { setQueue(current => ({ ...current,
                currentIndex: current.trackIds.indexOf(track.id) })); playTrack(track); }}
              style={s.railQueueRow}><Cover track={track} />
              <View style={s.trackText}><Text numberOfLines={1} style={s.trackTitle}>{track.title}</Text>
                <Text numberOfLines={1} style={s.trackArtist}>{track.artist}</Text></View></Pressable>)}
        </ScrollView>
      </View>}
    </View>
    <View style={[s.playerBar, !wide && s.playerBarCompact]}>
      <View style={[s.playerMainRow, !wide && s.playerMainRowCompact]}>
      <View style={s.nowPlaying}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open now playing"
          hoverAnimation={false} onPress={() => setPage('nowPlaying')} style={s.nowPlayingLink}>
          <Cover track={selected} large />
          <View style={s.trackText}>
            <Text numberOfLines={1} style={s.playerTitle}>{selected?.title ?? 'Choose a song'}</Text>
            <Text numberOfLines={1} style={s.trackArtist}>{selected?.artist || 'Your channel music will appear here'}</Text>
          </View>
        </Pressable>
        {selected && <View style={s.stickyActions}>
          <RowAction icon={favorites.includes(selected.id) ? 'favoriteFilled' : 'favorite'}
            label={`${favorites.includes(selected.id) ? 'Remove' : 'Add'} current song favorite`}
            active={favorites.includes(selected.id)} hoverAnimation={false}
            onPress={() => toggleFavorite(selected.id)} />
          <RowAction icon="playlist" label="Add current song to playlist"
            hoverAnimation={false}
            onPress={() => { setPlaylistPickerTrackId(selected.id); setPage('playlists'); }} />
        </View>}
      </View>
      <View style={s.playerCenter}>
      <View style={s.transport}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Repeat ${queue.repeat}`}
          accessibilityHint="Cycles through off, all songs, and one song"
          hoverAnimation={false} onPress={cycleRepeat} style={s.repeatButton}>
          <Icon name={queue.repeat === 'one' ? 'repeatOne' : 'repeatAll'} size={19}
            color={queue.repeat === 'off' ? c.muted : c.accent} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous track"
          onPress={() => changeTrack('previous')} style={s.transportButton}>
          <Icon name="previous" size={20} color={c.muted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={showPause ? 'Pause selected song' : 'Play selected song'}
          onPress={togglePlayback} disabled={!selected || (!online && !pinnedIds.has(selected.id))}
          style={[s.disabledPlay, canPlay && s.enabledPlay]}><Icon name={showPause ? 'pause' : 'play'}
            size={20} color={canPlay ? c.bg : c.muted} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Next track"
          onPress={() => changeTrack('next')} style={s.transportButton}>
          <Icon name="next" size={20} color={c.muted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Playback speed ${speed}x`}
          hoverAnimation={false} onPress={cycleSpeed} style={s.extraControl}><Icon name="speed" size={16} color={c.muted} />
          <Text style={s.extraControlText}>{speed}×</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={sleepUntil ?
          `Sleep timer ${Math.ceil(sleepRemaining / 60)} minutes remaining` : 'Sleep timer off'}
          hoverAnimation={false} onPress={cycleSleepTimer} style={s.extraControl}><Icon name="timer" size={16}
            color={sleepUntil ? c.accent : c.muted} />
          <Text style={s.extraControlText}>{sleepUntil ? `${Math.ceil(sleepRemaining / 60)}m` : 'Off'}</Text></Pressable>
      </View>
      </View>
      {wide && <View style={s.playerRight}>
        <View style={s.volumeRow}><Icon name="volume" size={17} color={c.muted} />
          <Pressable accessibilityRole="adjustable" accessibilityLabel="Volume"
            hoverAnimation={false}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(volume * 100) }}
            onLayout={event => setVolumeWidth(event.nativeEvent.layout.width)}
            onPress={event => changeVolume(event.nativeEvent.locationX / volumeWidth)}
            style={s.volumeTrack}><View style={[s.volumeFill, { width: `${volume * 100}%` }]}>
              <View style={s.volumeKnob} />
            </View></Pressable>
          <Text style={s.volumeValue}>{Math.round(volume * 100)}%</Text></View></View>}
      </View>
      <View style={s.playerProgressRow}>
        <Text style={s.time}>{clock(position)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Seek in song"
          hoverAnimation={false}
          onLayout={event => setProgressWidth(event.nativeEvent.layout.width)}
          onPress={event => seekTo(duration * event.nativeEvent.locationX / progressWidth)}
          style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${duration ? Math.min(100, position / duration * 100) : 0}%` }]}>
            <View style={s.progressKnob} />
          </View>
        </Pressable>
        <Text style={s.time}>{clock(duration)}</Text>
      </View>
    </View>
  </View></ArtworkContext.Provider>;
}

function RowAction({ icon, label, active = false, disabled = false, hoverAnimation, onPress }:
  { icon: IconName; label: string; active?: boolean; disabled?: boolean; hoverAnimation?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    hoverAnimation={hoverAnimation} onPress={onPress} style={[s.rowAction, disabled && s.rowActionDisabled]}>
    <Icon name={icon} size={16} color={active ? c.accent : c.muted} />
  </Pressable>;
}

function FilterChip({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={s.filterChip}>
    <Text numberOfLines={1} style={s.filterText}>{label}</Text>
  </Pressable>;
}

function RecordArt({ track, large = false, compact = false }:
  { track?: Track; large?: boolean; compact?: boolean }) {
  const index = track ? track.messageId % coverColors.length : 0;
  const variant = track ? track.messageId % 4 : 0;
  const letter = track?.title?.slice(0, 1).toUpperCase() || 'T';
  return <View style={[s.recordArt, large && s.recordArtLarge, compact && s.recordArtCompact,
    { backgroundColor: coverColors[index] }]}>
    {variant === 0 ? <View style={[s.recordCircle, large && s.recordCircleLarge,
      compact && s.recordCircleCompact]}><View style={[s.recordRing, large && s.recordRingLarge,
      compact && s.recordRingCompact]}>
      <Text style={[s.recordLetter, large && s.recordLetterLarge, compact && s.recordLetterCompact]}>{letter}</Text>
    </View></View> : variant === 1 ? <View style={s.artBars}>
      <View style={s.artBarTall} /><View style={s.artBarShort} /><View style={s.artBarTall} />
      <Text style={[s.artInitial, large && s.recordLetterLarge]}>{letter}</Text>
    </View> : variant === 2 ? <View style={s.artFrame}>
      <View style={s.artFrameInner}><Text style={[s.artInitial, large && s.recordLetterLarge]}>{letter}</Text></View>
    </View> : <View style={s.artOrbit}>
      <View style={s.artOrbitDot} /><Text style={[s.artInitial, large && s.recordLetterLarge]}>{letter}</Text>
    </View>}
    <View style={s.recordStripe} />
    <ArtworkImage track={track} />
  </View>;
}

function GroupCard({ icon, name, count, track, onPress }:
  { icon: IconName; name: string; count: number; track?: Track; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${name}`}
    onPress={onPress} style={s.groupCard}>
    <View style={s.groupCardArt}><RecordArt track={track} compact /></View>
    <Text numberOfLines={1} style={s.groupCardTitle}>{name}</Text>
    <View style={s.groupCardMeta}><Icon name={icon} size={13} color={c.muted} />
      <Text style={s.groupCardCount}>{count} songs</Text></View>
  </Pressable>;
}

function GroupRow({ icon, name, count, track, onPress }:
  { icon: IconName; name: string; count: number; track?: Track; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${name}`}
    onPress={onPress} style={s.groupRow}>
    <Cover track={track} large />
    <View style={s.trackText}><Text numberOfLines={1} style={s.groupRowTitle}>{name}</Text>
      <Text style={s.groupCardCount}>{count} {count === 1 ? 'song' : 'songs'}</Text></View>
    <Icon name={icon} size={17} color={c.muted} />
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

function OfflineInfo({ stats, error, onChangeLimit }: {
  stats: OfflineStats; error: string; onChangeLimit: () => void;
}) {
  const used = (stats.bytes / 1048576).toFixed(1);
  const limit = Math.round(stats.limitBytes / 1048576);
  return <View style={s.offlineCard}>
    <View style={s.cacheHeader}><View style={s.offlineHeading}>
      <Icon name="download" size={16} color={c.accent} />
      <Text style={s.cacheTitle}>OFFLINE SONGS</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Offline storage limit ${limit} MB`}
        onPress={onChangeLimit} disabled={!!stats.job && !stats.job.error}>
        <Text style={s.cacheClear}>Limit {limit} MB</Text></Pressable></View>
    <Text style={s.cacheValue}>{used} MB <Text style={s.cacheLimit}>/ {limit} MB · {stats.pinnedIds.length} songs</Text></Text>
    <View style={s.cacheMeter}><View style={[s.cacheMeterFill,
      { width: `${stats.limitBytes ? Math.min(100, stats.bytes / stats.limitBytes * 100) : 0}%` }]} /></View>
    {!!stats.job && <Text style={s.cacheHint}>{stats.job.error ||
      `Saving ${stats.job.completed + 1} of ${stats.job.total}…`}</Text>}
    {!!error && <Text style={s.authError}>{error}</Text>}
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
  sidebar: { width: 218, padding: 18, backgroundColor: '#0c1118' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 38 },
  brandMark: { width: 43, height: 43, borderRadius: 22 },
  brand: { color: c.text, fontSize: 21, fontWeight: '800', letterSpacing: -0.7 },
  brandTag: { color: c.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1.3, marginTop: 1 },
  navCaption: { color: '#708098', fontSize: 10, fontWeight: '800', letterSpacing: 1.6, marginBottom: 12, paddingHorizontal: 12 },
  sidebarDivider: { height: 1, backgroundColor: c.line, marginVertical: 22 },
  collectionCard: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 10, backgroundColor: c.raised },
  collectionIcon: { width: 34, height: 34, borderRadius: 7, backgroundColor: '#24485d', alignItems: 'center', justifyContent: 'center', marginRight: 9 },
  collectionTitle: { color: c.text, fontSize: 12, fontWeight: '700' },
  collectionCount: { color: c.muted, fontSize: 11, marginTop: 3 },
  sidebarBottom: { marginTop: 'auto' },
  cacheCard: { backgroundColor: c.raised, borderRadius: 11, padding: 12 },
  offlineCard: { backgroundColor: c.panel, borderRadius: 11, padding: 12, marginBottom: 14 },
  offlineHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  compactCache: { marginBottom: 16 },
  storageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 15 },
  storageCell: { flexGrow: 1, flexBasis: 190 },
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
  navActive: { backgroundColor: '#20303c', borderLeftWidth: 3, borderLeftColor: c.accent },
  navText: { color: c.muted, fontSize: 14, fontWeight: '600' },
  navTextActive: { color: c.text },
  compactNav: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 17, gap: 4 },
  compactBrandRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 8 },
  compactLogo: { width: 27, height: 27, borderRadius: 14 },
  compactBrand: { color: c.text, fontSize: 17, fontWeight: '800' },
  main: { flex: 1, minHeight: 0, paddingHorizontal: 26, paddingTop: 24 },
  pageScroll: { flex: 1 },
  pageScrollContent: { paddingBottom: 30 },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  breadcrumb: { color: c.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  topStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: c.panel,
    paddingVertical: 7, paddingHorizontal: 10, borderRadius: 20 },
  topStatusText: { color: c.muted, fontSize: 11, fontWeight: '600' },
  heading: { color: c.text, fontSize: 32, fontWeight: '800', letterSpacing: -1.1 },
  subtitle: { color: c.muted, fontSize: 13, marginTop: 5, marginBottom: 20 },
  search: { width: 260, backgroundColor: c.raised, borderRadius: 9,
    color: c.text, paddingHorizontal: 14, paddingVertical: 8, fontSize: 12 },
  groupSearch: { width: '100%', marginBottom: 14 },
  connectRow: { flexDirection: 'row', gap: 10 },
  connectInput: { flex: 1 },
  connectButton: { height: 42, paddingHorizontal: 18, borderRadius: 9, backgroundColor: c.accent,
    alignItems: 'center', justifyContent: 'center' },
  connectButtonText: { color: c.bg, fontWeight: '800' },
  setupPanel: { backgroundColor: c.panel, borderRadius: 12, padding: 16, marginBottom: 16 },
  setupTitle: { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  setupHelp: { color: c.muted, fontSize: 13 },
  authError: { color: '#ffaaa8', fontSize: 13 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 18, marginBottom: 16 },
  accountRowCompact: { flexWrap: 'wrap', gap: 12 },
  accountBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#19372f', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  accountText: { color: '#82dfb9', fontSize: 11, fontWeight: '700' },
  accountAction: { color: c.muted, fontSize: 11, fontWeight: '600' },
  playbackAlert: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, marginBottom: 15,
    backgroundColor: '#3a252d', borderRadius: 11 },
  connectionRecovery: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, marginBottom: 15,
    backgroundColor: c.panel, borderRadius: 11 },
  recoveryCopy: { flex: 1 },
  recoveryTitle: { color: c.text, fontSize: 12, fontWeight: '800' },
  recoveryDetail: { color: c.muted, fontSize: 11, marginTop: 3 },
  recoveryAction: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11,
    paddingVertical: 8, backgroundColor: c.raised, borderRadius: 8 },
  alertCopy: { flex: 1 },
  alertTitle: { color: '#ffd6db', fontSize: 12, fontWeight: '800' },
  alertDetail: { color: '#e4b8c2', fontSize: 11, marginTop: 3 },
  alertAction: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11,
    paddingVertical: 8, backgroundColor: '#5a3745', borderRadius: 8 },
  alertActionText: { color: c.soft, fontSize: 11, fontWeight: '700' },
  playlistPanel: { backgroundColor: c.panel, borderRadius: 12, padding: 15, marginBottom: 16 },
  panelEyebrow: { color: c.soft, fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginBottom: 10 },
  panelHelp: { color: c.muted, fontSize: 12, marginTop: 8 },
  playlistCreateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  playlistInput: { flex: 1, minWidth: 100, width: undefined },
  smallPrimary: { height: 36, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.accent,
    flexDirection: 'row', alignItems: 'center', gap: 5 },
  smallPrimaryText: { color: c.bg, fontSize: 12, fontWeight: '800' },
  smallSecondary: { height: 36, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.raised,
    flexDirection: 'row', alignItems: 'center', gap: 5 },
  smallSecondaryText: { color: c.soft, fontSize: 11, fontWeight: '700' },
  smallDanger: { height: 36, width: 36, borderRadius: 8, backgroundColor: '#54313c',
    alignItems: 'center', justifyContent: 'center' },
  playlistTabs: { marginTop: 12 },
  playlistTab: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 8,
    paddingHorizontal: 11, height: 34, backgroundColor: c.raised, marginRight: 7, maxWidth: 200 },
  playlistTabActive: { backgroundColor: '#3b3228' },
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
  hero: { minHeight: 194, backgroundColor: '#152a38', borderRadius: 18, marginBottom: 24,
    overflow: 'hidden', flexDirection: 'row', alignItems: 'center' },
  heroAccent: { width: 6, alignSelf: 'stretch', backgroundColor: c.accent },
  heroCopy: { flex: 1, paddingVertical: 22, paddingLeft: 26, paddingRight: 8 },
  heroEyebrow: { color: c.soft, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 8 },
  heroTitle: { color: c.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.9 },
  heroMeta: { color: '#b4c0c9', fontSize: 12, marginTop: 6, marginBottom: 16 },
  heroPlay: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: c.accent, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9 },
  heroPlayDisabled: { opacity: 0.5 },
  heroPlayText: { color: c.bg, fontSize: 12, fontWeight: '800' },
  heroShuffle: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 10,
    paddingHorizontal: 8, paddingVertical: 5 },
  heroArt: { width: 184, alignItems: 'center', justifyContent: 'center', marginRight: 16 },
  recordArt: { width: 164, height: 164, borderRadius: 12, overflow: 'hidden',
    justifyContent: 'center', alignItems: 'center' },
  recordArtLarge: { width: 240, height: 240, borderRadius: 15 },
  recordArtCompact: { width: 134, height: 104, borderRadius: 8 },
  recordCircle: { width: 126, height: 126, borderRadius: 63, backgroundColor: '#0b141f',
    justifyContent: 'center', alignItems: 'center', borderWidth: 8, borderColor: '#182b3a' },
  recordCircleLarge: { width: 192, height: 192, borderRadius: 96 },
  recordCircleCompact: { width: 94, height: 94, borderRadius: 47, borderWidth: 5 },
  recordRing: { width: 67, height: 67, borderRadius: 34, backgroundColor: '#213a48',
    borderWidth: 9, borderColor: '#334b56', justifyContent: 'center', alignItems: 'center' },
  recordRingLarge: { width: 104, height: 104, borderRadius: 52 },
  recordRingCompact: { width: 50, height: 50, borderRadius: 25, borderWidth: 6 },
  recordLetter: { color: c.soft, fontSize: 27, fontWeight: '900' },
  recordLetterLarge: { fontSize: 44 },
  recordLetterCompact: { fontSize: 19 },
  artBars: { height: '100%', width: '100%', flexDirection: 'row', alignItems: 'flex-end',
    justifyContent: 'space-around', paddingHorizontal: 16, overflow: 'hidden' },
  artBarTall: { width: 18, height: '86%', backgroundColor: '#7b9a9a66', transform: [{ rotate: '18deg' }] },
  artBarShort: { width: 18, height: '55%', backgroundColor: '#ffb86a88', transform: [{ rotate: '18deg' }] },
  artInitial: { position: 'absolute', alignSelf: 'center', top: '28%', color: '#f6f5ee',
    fontSize: 29, fontWeight: '900' },
  artFrame: { width: '76%', height: '76%', borderWidth: 2, borderColor: '#b8c7cb99',
    transform: [{ rotate: '-12deg' }], justifyContent: 'center', alignItems: 'center' },
  artFrameInner: { width: '72%', height: '72%', borderWidth: 2, borderColor: '#ffb86a99',
    justifyContent: 'center', alignItems: 'center' },
  artOrbit: { width: '75%', height: '75%', borderRadius: 100, borderWidth: 3,
    borderColor: '#c2d4cf88', justifyContent: 'center', alignItems: 'center' },
  artOrbitDot: { position: 'absolute', top: 8, right: 4, width: 13, height: 13,
    borderRadius: 7, backgroundColor: c.accent },
  recordStripe: { position: 'absolute', right: 0, bottom: 0, width: 54, height: 6, backgroundColor: c.accent },
  coverImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  coverEditButton: { alignSelf: 'flex-start', marginTop: 15, paddingVertical: 6 },
  coverEditText: { color: c.soft, fontSize: 12, fontWeight: '700' },
  coverEditPanel: { marginTop: 7, gap: 9, maxWidth: 440 },
  coverEditInput: { color: c.text, backgroundColor: c.raised, borderRadius: 8,
    borderWidth: 1, borderColor: c.line, paddingHorizontal: 11, paddingVertical: 8 },
  homeShelf: { marginBottom: 22 },
  shelfHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  shelfLink: { color: c.soft, fontSize: 12, fontWeight: '700' },
  groupCard: { width: 156, marginRight: 12, padding: 10, backgroundColor: c.panel,
    borderColor: c.line, borderWidth: 1, borderRadius: 12 },
  groupCardArt: { width: 134, height: 104, overflow: 'hidden', borderRadius: 8 },
  groupCardTitle: { color: c.text, fontSize: 12, fontWeight: '800', marginTop: 10 },
  groupCardMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  groupCardCount: { color: c.muted, fontSize: 10, marginTop: 3 },
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, marginBottom: 6,
    backgroundColor: c.panel, borderRadius: 10, borderWidth: 1, borderColor: c.line },
  groupRowTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  backLink: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginBottom: 12 },
  backLinkText: { color: c.soft, fontSize: 12, fontWeight: '700' },
  nowPage: { flexDirection: 'row', gap: 28, alignItems: 'center', padding: 24, marginBottom: 24,
    borderRadius: 18, backgroundColor: '#14212d' },
  nowPageCompact: { flexDirection: 'column', alignItems: 'stretch' },
  nowPageCopy: { flex: 1 },
  nowPageTitle: { color: c.text, fontSize: 28, fontWeight: '800', marginBottom: 6 },
  nowPageArtist: { color: c.muted, fontSize: 15, marginBottom: 17 },
  nowPageButtons: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  nowPageMeta: { color: c.muted, fontSize: 11, marginTop: 12 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  toolbarCompact: { flexWrap: 'wrap', gap: 12 },
  toolbarActions: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  toolbarActionsCompact: { width: '100%' },
  syncButton: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12,
    backgroundColor: c.raised, borderRadius: 9 },
  syncButtonDisabled: { opacity: 0.5 },
  syncButtonText: { color: c.soft, fontSize: 12, fontWeight: '700' },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, width: 240, height: 36,
    backgroundColor: c.raised, borderRadius: 9, paddingHorizontal: 12 },
  searchField: { flex: 1, color: c.text, paddingVertical: 4, fontSize: 12 },
  section: { color: c.text, fontSize: 18, fontWeight: '800' },
  sectionSub: { color: c.muted, fontSize: 11, marginTop: 2 },
  searchCompact: { flex: 1 },
  filterBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 12 },
  artistFilter: { color: c.text, backgroundColor: c.raised, borderRadius: 18, width: 165,
    paddingHorizontal: 11, paddingVertical: 5, fontSize: 11 },
  filterChip: { backgroundColor: c.raised, borderRadius: 18,
    paddingHorizontal: 11, paddingVertical: 6, maxWidth: 220 },
  filterText: { color: c.soft, fontSize: 11, fontWeight: '600' },
  tableHead: { flexDirection: 'row', alignItems: 'center', height: 32, marginBottom: 5 },
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
  rowAction: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  rowActionDisabled: { opacity: 0.35 },
  selected: { backgroundColor: '#24313a' },
  unavailableRow: { opacity: 0.45 },
  activeRowText: { color: c.soft },
  rowNumber: { color: c.muted, width: 22, fontSize: 11 },
  cover: { width: 40, height: 40, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginRight: 10,
    overflow: 'hidden' },
  coverLarge: { width: 48, height: 48, borderRadius: 9 },
  coverGlyph: { color: '#ffffff', fontSize: 20, fontWeight: '800', opacity: 0.9 },
  coverGlyphLarge: { fontSize: 24 },
  trackText: { flex: 1, minWidth: 0 },
  trackTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  trackArtist: { color: c.muted, fontSize: 11, marginTop: 3 },
  rowSize: { color: c.muted, fontSize: 11, width: 100 },
  rowDuration: { color: c.muted, fontSize: 11, width: 43, textAlign: 'right' },
  emptyCard: { alignItems: 'center', padding: 36, marginTop: 18, borderRadius: 14, backgroundColor: c.panel },
  emptyTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  empty: { color: c.muted, fontSize: 12, marginTop: 5, textAlign: 'center' },
  playerBar: { height: 92, paddingHorizontal: 22, paddingTop: 6, paddingBottom: 4,
    backgroundColor: '#0b0f14' },
  playerBarCompact: { height: 145, paddingTop: 8 },
  playerMainRow: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 0 },
  playerMainRowCompact: { flexDirection: 'column', alignItems: 'stretch' },
  nowPlaying: { flex: 1.25, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  nowPlayingLink: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  stickyActions: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 7 },
  playerTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  playerCenter: { flex: 1, minWidth: 0, alignItems: 'center' },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 46, gap: 3 },
  playerProgressRow: { flexDirection: 'row', alignItems: 'center', gap: 9, height: 19 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 1 },
  progressTrack: { flex: 1, height: 4, backgroundColor: '#4b5560', borderRadius: 2 },
  progressFill: { height: 4, backgroundColor: c.accent, borderRadius: 2, position: 'relative' },
  progressKnob: { position: 'absolute', right: -5, top: -4, width: 12, height: 12,
    borderRadius: 6, backgroundColor: c.text },
  time: { color: c.muted, fontSize: 10, width: 35, textAlign: 'center' },
  transportButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  extraControl: { width: 50, height: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 2, borderRadius: 8 },
  extraControlText: { color: c.muted, fontSize: 10, fontWeight: '700' },
  repeatButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  disabledPlay: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.raised,
    alignItems: 'center', justifyContent: 'center' },
  enabledPlay: { backgroundColor: c.accent },
  playerRight: { width: 165, alignItems: 'flex-end', justifyContent: 'center' },
  rightRail: { width: 250, padding: 17, backgroundColor: '#10151c', borderLeftWidth: 1, borderColor: c.line },
  railHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  railTitle: { color: c.text, fontSize: 15, fontWeight: '800' },
  railArt: { alignSelf: 'center', marginBottom: 13 },
  railSong: { color: c.text, fontSize: 15, fontWeight: '800' },
  railArtist: { color: c.muted, fontSize: 11, marginTop: 4 },
  railDivider: { height: 1, backgroundColor: c.line, marginVertical: 20 },
  railQueue: { flex: 1 },
  railQueueRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, gap: 2 },
  volumeRow: { width: 155, flexDirection: 'row', alignItems: 'center', gap: 7 },
  volumeTrack: { flex: 1, height: 4, backgroundColor: '#4b5560', borderRadius: 2 },
  volumeFill: { height: 4, backgroundColor: c.accent, borderRadius: 2, position: 'relative' },
  volumeKnob: { position: 'absolute', right: -5, top: -4, width: 12, height: 12,
    borderRadius: 6, backgroundColor: c.text },
  volumeValue: { color: c.muted, fontSize: 10, width: 29, textAlign: 'right' },
});
