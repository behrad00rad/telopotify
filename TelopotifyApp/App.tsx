import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList, Linking, NativeModules, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text,
  TextInput, useWindowDimensions, View,
} from 'react-native';
import { searchTracks, type Track } from './src/core/library';
import { advanceAfterEnd, createQueue, currentTrackId, nextTrack, previousTrack } from './src/core/queue';
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
  syncing: boolean; catalogRevision: number; lastSyncedAt: string | null; syncError: string };
type ChannelChoice = { index: number; title: string; selected: boolean };
type LibraryResponse = { channel: string; channelId: string | null; online: boolean; catalogRevision: number; tracks: Array<{
  messageId: number; title: string; artist: string; durationSeconds: number | null;
  fileSize: number; mimeType: string }> };

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
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState('stopped');
  const [position, setPosition] = useState(0);
  const [nativeDuration, setNativeDuration] = useState(0);
  const [progressWidth, setProgressWidth] = useState(1);
  const [volume, setVolume] = useState(1);
  const [volumeWidth, setVolumeWidth] = useState(1);
  const endedHandled = useRef(false);
  const [page, setPage] = useState<'library' | 'queue'>('library');
  const [queue, setQueue] = useState(() => createQueue([]));
  const visible = useMemo(() => searchTracks(tracks, query), [tracks, query]);
  const selected = tracks.find(track => track.id === currentTrackId(queue));
  const duration = nativeDuration || selected?.durationSeconds || 0;
  const items = page === 'library' ? visible : queue.trackIds.map(id => tracks.find(track => track.id === id)!).filter(Boolean);

  const playTrack = useCallback(async (track: Track) => {
    if (!bridge?.online) return;
    const url = `${bridge.base}/audio/${track.messageId}?token=${encodeURIComponent(bridge.token)}`;
    try {
      if (Platform.OS === 'windows') {
        if (!NativeModules.TelopotifyAudio) throw new Error('Windows audio module is unavailable');
        NativeModules.TelopotifyAudio.play(url);
      } else {
        await Linking.openURL(url);
      }
      endedHandled.current = false;
      setPlayingTrackId(track.id);
      setPaused(false);
      setPlaybackStatus(Platform.OS === 'windows' ? 'opening' : 'playing');
      setPosition(0);
      setNativeDuration(0);
    } catch (error) {
      setConnectionStatus(error instanceof Error ? error.message : 'Playback failed');
    }
  }, [bridge]);

  useEffect(() => {
    if (Platform.OS !== 'windows' || !playingTrackId || !bridge?.online) return;
    const refresh = () => {
      try {
        const audio = NativeModules.TelopotifyAudio;
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
    setTracks(library);
    if (sameLibrary) {
      setQueue(current => {
        const available = new Set(library.map(track => track.id));
        const kept = current.trackIds.filter(id => available.has(id));
        const queued = new Set(kept);
        const added = library.map(track => track.id).filter(id => !queued.has(id));
        const trackIds = [...kept, ...added];
        const currentId = currentTrackId(current);
        return { ...current, trackIds, currentIndex: Math.max(0, trackIds.indexOf(currentId ?? '')) };
      });
    } else {
      setQueue(createQueue(library.map(track => track.id)));
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
  }, []);

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
    if (data.syncError) setSyncMessage('Sync will retry when Telegram is available.');
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
      }
      lastOnline.current = false;
      setBridge(current => current && current.token === connection.token && current.online ?
        { ...current, online: false } : current);
    }
  }, [loadChannels, loadLibrary]);

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
      setChannelName('');
      loadedChannel.current = '';
      loadedToken.current = '';
      loadedCount.current = 0;
      loadedRevision.current = -1;
      setSyncMessage('');
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
  const pageTitle = page === 'library' ? 'Your music' : 'Play queue';

  return <View style={s.root}>
    <StatusBar barStyle="light-content" backgroundColor={c.bg} />
    <View style={s.body}>
      {wide && <View style={s.sidebar}>
        <View style={s.brandRow}><View style={s.brandMark}><Icon name="music" size={22} color={c.bg} /></View>
          <View><Text style={s.brand}>telopotify</Text><Text style={s.brandTag}>TELEGRAM MUSIC</Text></View></View>
        <Text style={s.navCaption}>YOUR SPACE</Text>
        <Nav icon="library" label="Library" active={page === 'library'} onPress={() => setPage('library')} />
        <Nav icon="queue" label="Queue" active={page === 'queue'} onPress={() => setPage('queue')} />
        <View style={s.sidebarDivider} />
        <Text style={s.navCaption}>YOUR COLLECTION</Text>
        <View style={s.collectionCard}><View style={s.collectionIcon}><Icon name="music" size={18} /></View>
          <View style={s.trackText}><Text numberOfLines={1} style={s.collectionTitle}>{channelName || 'Telegram channel'}</Text>
            <Text style={s.collectionCount}>{tracks.length} songs</Text></View></View>
        <View style={s.sidebarBottom}>
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
          <Nav icon="queue" label="Queue" active={page === 'queue'} onPress={() => setPage('queue')} />
        </View>}
        <View style={s.topLine}><Text style={s.breadcrumb}>MY MUSIC  /  {page === 'library' ? 'LIBRARY' : 'QUEUE'}</Text>
          <View style={s.topStatus}><View style={[s.statusDot, !online && s.statusDotIdle]} />
            <Text style={s.topStatusText}>{currentLabel}</Text></View></View>
        <Text style={s.heading}>{pageTitle}</Text>
        <Text style={s.subtitle}>{page === 'library' ? 'Every song from your channel, ready when you are.' :
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
              disabled={!online} onPress={() => {
                setQueue(current => ({ ...createQueue(tracks.map(track => track.id), tracks[0].id), repeat: current.repeat }));
                playTrack(tracks[0]);
              }}
              style={[s.heroPlay, !online && s.heroPlayDisabled]}><Icon name="play" size={15} color="#1b1730" />
              <Text style={s.heroPlayText}>Play collection</Text></Pressable>
          </View>{wide && <View style={s.heroArt}><View style={s.heroRecord}><View style={s.heroRecordInner}>
            <Icon name="music" size={28} color={c.soft} /></View></View></View>}
        </View>}
        <View style={[s.toolbar, !wide && s.toolbarCompact]}><View><Text style={s.section}>{page === 'library' ? 'All songs' : 'Up next'}</Text>
          <Text style={s.sectionSub}>{items.length.toLocaleString()} tracks{page === 'library' && query ? ' found' : ''}{syncMessage ? ` · ${syncMessage}` : ''}</Text></View>
          {page === 'library' && <View style={[s.toolbarActions, !wide && s.toolbarActionsCompact]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Sync new songs"
              disabled={!online || syncBusy || syncing} onPress={syncLibrary}
              style={[s.syncButton, (!online || syncBusy || syncing) && s.syncButtonDisabled]}>
              <Icon name="sync" size={15} color={c.soft} /><Text style={s.syncButtonText}>{syncBusy || syncing ? 'Syncing' : 'Sync'}</Text>
            </Pressable>
            <View style={[s.searchBox, !wide && s.searchCompact]}><Icon name="search" size={16} color={c.muted} />
              <TextInput accessibilityLabel="Search songs" placeholder="Search songs or artists"
                placeholderTextColor={c.muted} value={query} onChangeText={setQuery} style={s.searchField} /></View>
          </View>}</View>
        <View style={s.tableHead}><Text style={s.tableNumber}>#</Text><View style={s.tableCover} /><Text style={s.tableTitle}>TITLE</Text>
          {wide && <Text style={s.tableSize}>SIZE</Text>}<Text style={s.tableDuration}>TIME</Text></View>
        <FlatList data={items} keyExtractor={item => item.id}
          renderItem={({ item, index }) => <Pressable
            accessibilityRole="button" accessibilityLabel={`Play ${item.title}`}
            onPress={() => {
              setQueue(current => page === 'library'
                ? { ...createQueue(tracks.map(track => track.id), item.id), repeat: current.repeat }
                : { ...current, currentIndex: index });
              playTrack(item);
            }}
            style={[s.row, selected?.id === item.id && s.selected]}>
            <Text style={[s.rowNumber, selected?.id === item.id && s.activeRowText]}>{String(index + 1).padStart(2, '0')}</Text>
            <Cover track={item} />
            <View style={s.trackText}>
              <Text numberOfLines={1} style={[s.trackTitle, selected?.id === item.id && s.activeRowText]}>{item.title}</Text>
              <Text numberOfLines={1} style={s.trackArtist}>{item.artist}</Text>
            </View>
            {wide && <Text style={s.rowSize}>{size(item.fileSize)}</Text>}
            <Text style={s.rowDuration}>{item.durationSeconds ? clock(item.durationSeconds) : '—'}</Text>
          </Pressable>}
          ListEmptyComponent={<View style={s.emptyCard}><Icon name="music" size={28} color={c.accent} />
            <Text style={s.emptyTitle}>{query ? 'No songs found' : page === 'queue' ? 'Your queue is empty' : 'Your songs will appear here'}</Text>
            <Text style={s.empty}> {query ? 'Try a different title or artist.' : connectionStatus}</Text></View>} />
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
        <Text style={s.playerRightLabel}>{playingTrackId === selected?.id ? playbackStatus.toUpperCase() : 'READY TO PLAY'}</Text>
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

function Nav({ icon, label, active, onPress }: { icon: IconName; label: string; active: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }}
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
  connection: { color: c.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#61d9a8' },
  statusDotIdle: { backgroundColor: '#e8b873' },
  statusText: { color: c.text, fontSize: 12, fontWeight: '700' },
  nav: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 15, borderRadius: 9, marginBottom: 5, gap: 13 },
  navActive: { backgroundColor: '#2a2545' },
  navText: { color: c.muted, fontSize: 14, fontWeight: '600' },
  navTextActive: { color: c.text },
  compactNav: { flexDirection: 'row', alignItems: 'center', marginBottom: 17, gap: 4 },
  compactBrand: { color: c.text, fontSize: 17, fontWeight: '800', marginRight: 'auto' },
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
  tableHead: { flexDirection: 'row', alignItems: 'center', height: 32, borderBottomWidth: 1, borderBottomColor: c.line, marginBottom: 5 },
  tableNumber: { color: '#7b899f', width: 30, fontSize: 10, paddingLeft: 10 },
  tableCover: { width: 50 },
  tableTitle: { color: '#7b899f', flex: 1, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  tableSize: { color: '#7b899f', width: 100, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  tableDuration: { color: '#7b899f', width: 52, fontSize: 10, fontWeight: '800', letterSpacing: 1, textAlign: 'right', paddingRight: 9 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, paddingHorizontal: 9, borderRadius: 8, marginBottom: 2 },
  selected: { backgroundColor: '#27283f' },
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
