import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AppState, FlatList, Image, Modal, NativeEventEmitter, NativeModules, Pressable,
  SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput,
  TouchableOpacity, View} from 'react-native';
import {Icon, IconName} from '../components/Icon';

type Track = {messageId: string; fileId: number; fileSize: number; mimeType: string;
  title: string; artist: string; album: string; coverFileId: number; durationSeconds: number};
type Auth = {state: string; error?: string};
type Channel = {id: string; title: string};
type Page = {tracks: Track[]; nextCursor: string; hasMore: boolean};
type Catalog = {tracks: Track[]; cursor: string; more: boolean};
type Snapshot = {status: string; messageId: string; title: string; artist: string;
  position: number; duration: number; queueIndex: number; queueCount: number};
type Library = {liked: string[]; playlists: Record<string, string[]>};
type Tab = 'Home' | 'Songs' | 'Artists' | 'Albums' | 'Playlists';
const tg = NativeModules.TelopotifyTelegram as {
  start(): Promise<Auth>; getState(): Promise<Auth>; sendPhone(v: string): Promise<void>;
  sendCode(v: string): Promise<void>; sendPassword(v: string): Promise<void>;
  listChannels(): Promise<Channel[]>; selectChannel(id: string): Promise<Channel>;
  getSelectedChannel(): Promise<string | null>; getTrackPage(cursor: string): Promise<Page>;
  getCatalog(channelId: string): Promise<string>; saveCatalog(channelId: string, value: string): Promise<boolean>;
  reconnect(): Promise<unknown>; trimCache(): Promise<unknown>;
  getArtwork(id: number): Promise<string | null>;
  getLibraryState(): Promise<string>; saveLibraryState(value: string): Promise<boolean>;
};
const audio = NativeModules.TelopotifyAudio as {
  setQueue(tracks: Track[], startId: string): void; appendQueue(tracks: Track[]): void;
  next(): void; previous(): void; pause(): void; resume(): void; seek(seconds: number): void;
  getSnapshot(): Promise<Snapshot>;
};
const initial: Snapshot = {status: 'stopped', messageId: '', title: '', artist: '',
  position: 0, duration: 0, queueIndex: -1, queueCount: 0};
const artCache = new Map<number, string | null>();
const artistOf = (t: Track) => t.artist?.trim() || 'Unknown artist';
const albumOf = (t: Track) => t.album?.trim() || 'Singles & untagged';
const time = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
const nav: {name: Tab; icon: IconName}[] = [
  {name: 'Home', icon: 'home'}, {name: 'Songs', icon: 'music'},
  {name: 'Artists', icon: 'artist'}, {name: 'Albums', icon: 'album'},
  {name: 'Playlists', icon: 'playlist'},
];

function Art({id, size, round = false}: {id: number; size: number; round?: boolean}) {
  const [uri, setUri] = useState<string | null>(artCache.get(id) ?? null);
  useEffect(() => {
    let alive = true;
    setUri(artCache.get(id) ?? null);
    if (id > 0 && !artCache.has(id)) { tg.getArtwork(id).then(value => {
      artCache.set(id, value); if (alive) { setUri(value); }
    }).catch(() => { artCache.set(id, null); }); }
    return () => { alive = false; };
  }, [id]);
  const shape = {width: size, height: size, borderRadius: round ? size / 2 : 7};
  return <View style={[s.art, shape]}>{uri ?
    <Image source={{uri}} style={shape} /> : <Icon name="music" size={size * 0.28} color="#8292a2" />}
  </View>;
}
function Button({icon, label, onPress, color = '#eff3f7', size = 21}:
  {icon: IconName; label: string; onPress: () => void; color?: string; size?: number}) {
  return <TouchableOpacity accessibilityRole="button" accessibilityLabel={label}
    style={s.iconButton} onPress={onPress}><Icon name={icon} color={color} size={size} /></TouchableOpacity>;
}

export default function IOSApp() {
  const [auth, setAuth] = useState<Auth>({state: 'starting'});
  const [input, setInput] = useState(''); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [channels, setChannels] = useState<Channel[]>([]);
  const [channel, setChannel] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [tracks, setTracks] = useState<Track[]>([]); const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('Home'); const [scope, setScope] = useState<{name: string; tracks: Track[]} | null>(null);
  const [search, setSearch] = useState(''); const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [nowOpen, setNowOpen] = useState(false); const [progressWidth, setProgressWidth] = useState(1);
  const [library, setLibrary] = useState<Library>({liked: [], playlists: {}});
  const [playlistName, setPlaylistName] = useState(''); const [addSong, setAddSong] = useState<Track | null>(null);
  const allQueueRef = useRef(false); const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    const events = new NativeEventEmitter(NativeModules.TelopotifyTelegram);
    const sub = events.addListener('telegramState', (next: Auth) => {
      setAuth(next); setError(next.error ?? ''); setInput('');
    });
    tg.start().then(setAuth).catch(e => setError(String(e)));
    tg.getLibraryState().then(raw => {
      const saved = JSON.parse(raw) as Partial<Library>;
      setLibrary({liked: saved.liked ?? [], playlists: saved.playlists ?? {}});
    }).catch(() => {});
    tg.getSelectedChannel().then(setChannel).catch(e => setError(String(e)))
      .finally(() => setRestoring(false));
    return () => sub.remove();
  }, []);
  const ready = auth.state === 'authorizationStateReady';
  const phone = auth.state === 'authorizationStateWaitPhoneNumber';
  const code = auth.state === 'authorizationStateWaitCode';
  const password = auth.state === 'authorizationStateWaitPassword';
  const prompt = phone ? 'Phone number with country code' : code ? 'Telegram code' : 'Two-step password';

  const refreshChannels = useCallback(async () => {
    try { setChannels(await tg.listChannels()); }
    catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { if (ready && !channel && !restoring) { refreshChannels(); } }, [ready, channel, restoring, refreshChannels]);
  useEffect(() => { if (!ready) { return; }
    tg.trimCache().catch(() => {});
  }, [ready]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        tg.reconnect().catch(() => {});
        audio.getSnapshot().then(value => {
          if (value.status !== 'playing' && value.status !== 'opening') { tg.trimCache().catch(() => {}); }
        }).catch(() => {});
        setRetryNonce(n => n + 1);
      }
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!ready || !channel) { return; }
    let cancelled = false; let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const index = async () => {
      let catalog: Catalog = {tracks: [], cursor: '', more: true};
      try {
        const raw = await tg.getCatalog(channel);
        if (raw) { const saved = JSON.parse(raw) as Catalog;
          if (Array.isArray(saved.tracks) && typeof saved.cursor === 'string') {
            catalog = {tracks: saved.tracks, cursor: saved.cursor, more: saved.more !== false};
          }
        }
      } catch { /* A missing or old catalog can be indexed again. */ }
      if (cancelled) { return; }
      setTracks(catalog.tracks);
      setLoading(true); setError('');
      try {
        // Scan new messages until they meet the saved catalog, then resume its older cursor.
        const savedTracks = catalog.tracks;
        const known = new Set(savedTracks.map(t => t.messageId));
        const resumeCursor = catalog.cursor;
        const resumeMore = catalog.more;
        const recent: Track[] = [];
        let refreshing = savedTracks.length > 0;
        let from = '';
        while (!cancelled) {
          const page = await tg.getTrackPage(from);
          if (cancelled) { break; }
          const seen = new Set(catalog.tracks.map(t => t.messageId));
          const fresh = page.tracks.filter(t => !seen.has(t.messageId));
          if (refreshing) {
            recent.push(...fresh);
            catalog.tracks = [...recent, ...savedTracks];
          } else { catalog.tracks = [...catalog.tracks, ...fresh]; }
          if (fresh.length && allQueueRef.current) { audio.appendQueue(fresh); }
          const next = page.nextCursor;
          const pageHasMore = page.hasMore && !!next && next !== from;
          if (refreshing && (page.tracks.some(t => known.has(t.messageId)) || !pageHasMore)) {
            refreshing = false;
            from = resumeCursor;
            catalog.more = resumeMore && !!resumeCursor;
            catalog.cursor = from;
          } else if (refreshing) {
            from = next;
            catalog.cursor = resumeCursor;
            catalog.more = resumeMore;
          } else {
            from = next;
            catalog.more = pageHasMore;
            catalog.cursor = from;
          }
          setTracks(catalog.tracks);
          await tg.saveCatalog(channel, JSON.stringify(catalog));
          if (!catalog.more) { break; }
        }
      } catch (e) {
        if (!cancelled) { setError(`Indexing paused: ${String(e)}`);
          retryTimer = setTimeout(() => setRetryNonce(n => n + 1), 15000); }
      } finally { if (!cancelled) { setLoading(false); } }
    };
    index();
    return () => { cancelled = true; if (retryTimer) { clearTimeout(retryTimer); } };
  }, [ready, channel, retryNonce]);
  useEffect(() => { if (!ready) { return; }
    let alive = true;
    const poll = () => audio.getSnapshot().then(value => { if (alive) { setSnapshot(value); } }).catch(() => {});
    poll(); const timer = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [ready]);

  const byId = useMemo(() => new Map(tracks.map(t => [t.messageId, t])), [tracks]);
  const current = byId.get(snapshot.messageId);
  const groups = useCallback((kind: 'artist' | 'album') => {
    const map = new Map<string, Track[]>();
    tracks.forEach(t => { const name = kind === 'artist' ? artistOf(t) : albumOf(t);
      const group = map.get(name) ?? []; group.push(t); map.set(name, group); });
    return [...map].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tracks]);
  const artists = useMemo(() => groups('artist'), [groups]);
  const albums = useMemo(() => groups('album'), [groups]);
  const visible = useMemo(() => { const source = scope?.tracks ?? tracks; const q = search.trim().toLowerCase();
    return q ? source.filter(t => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)) : source;
  }, [scope, tracks, search]);
  const likedTracks = library.liked.map(id => byId.get(id)).filter((t): t is Track => !!t);

  const persist = (next: Library) => { setLibrary(next);
    tg.saveLibraryState(JSON.stringify(next)).catch(e => setError(String(e))); };
  const like = (t: Track) => persist({...library, liked: library.liked.includes(t.messageId)
    ? library.liked.filter(id => id !== t.messageId) : [...library.liked, t.messageId]});
  const createPlaylist = () => { const name = playlistName.trim();
    if (!name || library.playlists[name] || name === 'Liked Songs') { return; }
    persist({...library, playlists: {...library.playlists, [name]: []}}); setPlaylistName(''); };
  const addTo = (name: string, t: Track) => { const ids = library.playlists[name] ?? [];
    if (!ids.includes(t.messageId)) { persist({...library, playlists: {...library.playlists,
      [name]: [...ids, t.messageId]}}); } setAddSong(null); };
  const chooseTab = (name: Tab) => { setTab(name); setScope(null); setSearch(''); };
  const openGroup = (name: string, group: Track[]) => { setScope({name, tracks: group}); setSearch(''); setTab('Songs'); };
  const play = (t: Track, context: Track[]) => {
    if (!t.fileId || !t.fileSize) { setError('This song is unavailable.'); return; }
    allQueueRef.current = context === tracks;
    audio.setQueue(context.filter(item => item.fileId > 0 && item.fileSize > 0), t.messageId);
    setSnapshot({...initial, status: 'opening', messageId: t.messageId,
      title: t.title, artist: t.artist, duration: t.durationSeconds});
  };
  const toggle = () => snapshot.status === 'playing' ? audio.pause() : audio.resume();
  const seek = (x: number) => { const duration = snapshot.duration || current?.durationSeconds || 0;
    if (duration > 0) { audio.seek(duration * Math.max(0, Math.min(1, x / progressWidth))); } };
  const submit = async () => { if (!input.trim() || busy) { return; }
    setBusy(true); setError('');
    try { if (phone) { await tg.sendPhone(input.trim()); }
      else if (code) { await tg.sendCode(input.trim()); }
      else if (password) { await tg.sendPassword(input); } }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const chooseChannel = async (c: Channel) => {
    try { await tg.selectChannel(c.id); setChannel(c.id); setTracks([]);
      setScope(null); setTab('Home'); setError(''); }
    catch (e) { setError(String(e)); }
  };

  const row = (t: Track, context: Track[]) => <TouchableOpacity key={t.messageId}
    style={s.row} onPress={() => play(t, context)} accessibilityRole="button">
    <Art id={t.coverFileId} size={48} />
    <View style={s.rowCopy}><Text style={[s.rowTitle, snapshot.messageId === t.messageId && s.accent]}
      numberOfLines={1}>{t.title}</Text><Text style={s.rowSub} numberOfLines={1}>{artistOf(t)}</Text></View>
    <Button icon={library.liked.includes(t.messageId) ? 'favoriteFilled' : 'favorite'}
      label={library.liked.includes(t.messageId) ? 'Unlike' : 'Like'} onPress={() => like(t)}
      color={library.liked.includes(t.messageId) ? '#eba068' : '#8191a0'} />
    <Button icon="add" label="Add to playlist" onPress={() => setAddSong(t)} color="#8191a0" />
  </TouchableOpacity>;
  const groupRow = (name: string, group: Track[], kind: 'artist' | 'album') =>
    <TouchableOpacity key={name} style={s.groupRow} onPress={() => openGroup(name, group)}>
      <Art id={group[0]?.coverFileId ?? 0} size={60} round={kind === 'artist'} />
      <View style={s.rowCopy}><Text style={s.rowTitle} numberOfLines={1}>{name}</Text>
        <Text style={s.rowSub}>{group.length} songs</Text></View>
      <Icon name="next" size={16} color="#8292a2" />
    </TouchableOpacity>;

  if (!ready || !channel) { return <SafeAreaView style={s.screen}>
    <StatusBar barStyle="light-content" />
    <ScrollView contentContainerStyle={s.setup} keyboardShouldPersistTaps="handled">
      <Image source={require('../../assets/telopotify-logo.png')} style={s.mark} />
      <Text style={s.eyebrow}>TELOPOTIFY</Text>
      <Text style={s.setupTitle}>{ready && !restoring ? 'Choose your channel.' : 'Your music, anywhere.'}</Text>
      <Text style={s.setupCopy}>{ready ? 'Pick the Telegram channel with your songs.' :
        phone || code || password ? prompt : 'Connecting directly to Telegram on this iPhone.'}</Text>
      {(phone || code || password) && <><TextInput style={s.input} value={input} onChangeText={setInput}
        placeholder={prompt} placeholderTextColor="#738292" autoCapitalize="none" autoCorrect={false}
        keyboardType={phone ? 'phone-pad' : 'default'} secureTextEntry={password} onSubmitEditing={submit} />
        <TouchableOpacity style={s.primary} onPress={submit} disabled={busy || !input.trim()}>
          <Text style={s.primaryText}>{busy ? 'Connecting…' : 'Continue'}</Text></TouchableOpacity></>}
      {ready && !restoring && channels.map(c => <TouchableOpacity key={c.id} style={s.channelRow} onPress={() => chooseChannel(c)}>
        <View style={s.channelMark}><Text style={s.rowTitle}>{c.title.slice(0, 1).toUpperCase()}</Text></View>
        <Text style={s.rowTitle}>{c.title}</Text></TouchableOpacity>)}
      <TouchableOpacity style={s.textButton} onPress={ready ? refreshChannels :
        () => tg.getState().then(setAuth).catch(e => setError(String(e)))}>
        <Text style={s.accent}>{ready ? 'Refresh channels' : 'Check connection'}</Text></TouchableOpacity>
      {!!error && <Text style={s.error}>{error}</Text>}
    </ScrollView>
  </SafeAreaView>; }

  return <SafeAreaView style={s.screen}>
    <StatusBar barStyle="light-content" />
    <View style={s.header}><View><Text style={s.eyebrow}>YOUR CHANNEL</Text>
      <Text style={s.headerTitle}>{tab}</Text></View>
      <Button icon="sync" label="Switch channel" onPress={() => setChannel(null)} /></View>
    {!!error && <TouchableOpacity style={s.banner} onPress={() => {
      tg.reconnect().catch(() => {}); setRetryNonce(n => n + 1);
    }}><Text style={s.bannerText}>{error}  ·  Tap to retry</Text></TouchableOpacity>}

    {tab === 'Home' && <ScrollView style={s.page} contentContainerStyle={s.content}>
      <Text style={s.welcome}>Listen to what you love.</Text>
      <Text style={s.muted}>{tracks.length} songs from Telegram{loading ? ' · indexing…' : ''}</Text>
      <Text style={s.section}>Your library</Text>
      <View style={s.quickGrid}>
        <TouchableOpacity style={s.quickCard} onPress={() => openGroup('Liked Songs', likedTracks)}>
          <Icon name="favoriteFilled" size={26} color="#eba068" />
          <Text style={s.quickName}>Liked Songs</Text><Text style={s.rowSub}>{likedTracks.length} songs</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.quickCard} onPress={() => chooseTab('Songs')}>
          <Icon name="music" size={26} color="#eba068" />
          <Text style={s.quickName}>All songs</Text><Text style={s.rowSub}>{tracks.length} songs</Text>
        </TouchableOpacity>
      </View>
      <View style={s.sectionRow}><Text style={s.section}>Recently added</Text>
        <TouchableOpacity onPress={() => chooseTab('Songs')}><Text style={s.smallAction}>View all</Text></TouchableOpacity></View>
      {tracks.slice(0, 8).map(t => row(t, tracks))}
      <View style={s.sectionRow}><Text style={s.section}>Artists</Text>
        <TouchableOpacity onPress={() => chooseTab('Artists')}><Text style={s.smallAction}>View all</Text></TouchableOpacity></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>{artists.slice(0, 8).map(([name, group]) =>
        <TouchableOpacity key={name} style={s.artistCard} onPress={() => openGroup(name, group)}>
          <Art id={group[0]?.coverFileId ?? 0} size={110} round />
          <Text style={s.artistName} numberOfLines={1}>{name}</Text></TouchableOpacity>)}</ScrollView>
    </ScrollView>}

    {tab === 'Songs' && <View style={s.page}>
      {!!scope && <TouchableOpacity style={s.back} onPress={() => setScope(null)}>
        <Text style={s.accent}>‹  All songs</Text></TouchableOpacity>}
      <View style={s.listHeading}><Text style={s.section}>{scope?.name ?? 'All songs'}</Text>
        <Text style={s.muted}>{visible.length} songs</Text></View>
      <TextInput style={s.search} placeholder="Search songs or artists" placeholderTextColor="#738292"
        value={search} onChangeText={setSearch} />
      <FlatList data={visible} keyExtractor={t => t.messageId} renderItem={({item}) => row(item, visible)}
        contentContainerStyle={s.list} initialNumToRender={18} maxToRenderPerBatch={24} windowSize={7}
        ListEmptyComponent={<Text style={s.empty}>No songs here yet.</Text>} />
    </View>}
    {tab === 'Artists' && <FlatList style={s.page} data={artists} keyExtractor={item => item[0]}
      renderItem={({item}) => groupRow(item[0], item[1], 'artist')} contentContainerStyle={s.list}
      ListHeaderComponent={<Text style={s.intro}>Browse by artist</Text>} />}
    {tab === 'Albums' && <FlatList style={s.page} data={albums} keyExtractor={item => item[0]}
      renderItem={({item}) => groupRow(item[0], item[1], 'album')} contentContainerStyle={s.list}
      ListHeaderComponent={<Text style={s.intro}>Albums named in Telegram captions appear here.</Text>} />}
    {tab === 'Playlists' && <ScrollView style={s.page} contentContainerStyle={s.content}>
      <Text style={s.intro}>Your playlists stay on this iPhone.</Text>
      <View style={s.createRow}><TextInput style={s.playlistInput} placeholder="New playlist name"
        placeholderTextColor="#738292" value={playlistName} onChangeText={setPlaylistName}
        onSubmitEditing={createPlaylist} />
        <Button icon="add" label="Create playlist" onPress={createPlaylist} color="#eba068" /></View>
      {groupRow('Liked Songs', likedTracks, 'album')}
      {Object.entries(library.playlists).map(([name, ids]) => groupRow(name,
        ids.map(id => byId.get(id)).filter((t): t is Track => !!t), 'album'))}
    </ScrollView>}

    {!!snapshot.messageId && <TouchableOpacity style={s.mini} activeOpacity={0.9} onPress={() => setNowOpen(true)}>
      <Art id={current?.coverFileId ?? 0} size={46} />
      <View style={s.rowCopy}><Text style={s.rowTitle} numberOfLines={1}>{snapshot.title}</Text>
        <Text style={s.rowSub} numberOfLines={1}>{snapshot.artist || 'Unknown artist'}</Text></View>
      {current && <Button icon={library.liked.includes(current.messageId) ? 'favoriteFilled' : 'favorite'}
        label="Like song" color="#eba068" onPress={() => like(current)} />}
      <Button icon={snapshot.status === 'playing' ? 'pause' : 'play'} label="Play or pause"
        onPress={toggle} size={25} />
      <View style={[s.miniProgress, {width: `${Math.min(100, 100 * snapshot.position /
        Math.max(1, snapshot.duration || current?.durationSeconds || 1))}%`}]} />
    </TouchableOpacity>}
    <View style={s.nav}>{nav.map(item => <TouchableOpacity key={item.name} style={s.navItem}
      accessibilityRole="tab" accessibilityState={{selected: tab === item.name}}
      onPress={() => chooseTab(item.name)}><Icon name={item.icon} size={20}
        color={tab === item.name ? '#eba068' : '#8393a2'} />
      <Text style={[s.navLabel, tab === item.name && s.accent]}>{item.name}</Text>
    </TouchableOpacity>)}</View>

    <Modal visible={nowOpen} animationType="slide" onRequestClose={() => setNowOpen(false)}>
      <SafeAreaView style={s.nowScreen}><StatusBar barStyle="light-content" />
        <View style={s.nowHeader}><Button icon="down" label="Close Now Playing" onPress={() => setNowOpen(false)} />
          <Text style={s.eyebrow}>NOW PLAYING</Text><View style={s.iconButton} /></View>
        <View style={s.nowBody}><View style={s.largeArt}><Art id={current?.coverFileId ?? 0} size={270} /></View>
          <View style={s.nowTitleRow}><View style={s.rowCopy}>
            <Text style={s.nowTitle} numberOfLines={2}>{snapshot.title}</Text>
            <Text style={s.nowArtist}>{snapshot.artist || 'Unknown artist'}</Text></View>
            {current && <Button icon={library.liked.includes(current.messageId) ? 'favoriteFilled' : 'favorite'}
              label="Like song" color="#eba068" onPress={() => like(current)} />}
            {current && <Button icon="add" label="Add to playlist" onPress={() => {
              setNowOpen(false); setAddSong(current);
            }} />}
          </View>
          <Pressable style={s.progressTouch} accessibilityRole="adjustable" accessibilityLabel="Song progress"
            onLayout={e => setProgressWidth(e.nativeEvent.layout.width)} onPress={e => seek(e.nativeEvent.locationX)}>
            <View style={s.progressTrack}><View style={[s.progressFill,
              {width: `${Math.min(100, 100 * snapshot.position /
                Math.max(1, snapshot.duration || current?.durationSeconds || 1))}%`}]}>
              <View style={s.progressDot} />
            </View></View>
          </Pressable>
          <View style={s.timeRow}><Text style={s.time}>{time(snapshot.position)}</Text>
            <Text style={s.time}>{time(snapshot.duration || current?.durationSeconds || 0)}</Text></View>
          <View style={s.controls}><Button icon="previous" label="Previous song" size={28} onPress={() => audio.previous()} />
            <TouchableOpacity style={s.bigPlay} onPress={toggle} accessibilityRole="button" accessibilityLabel="Play or pause">
              <Icon name={snapshot.status === 'playing' ? 'pause' : 'play'} size={32} color="#10151b" />
            </TouchableOpacity><Button icon="next" label="Next song" size={28} onPress={() => audio.next()} /></View>
          <Text style={s.queueNote}>{snapshot.queueIndex + 1} of {snapshot.queueCount} in queue</Text>
          {snapshot.status.startsWith('error:') && <Text style={s.error}>{snapshot.status}</Text>}
        </View>
      </SafeAreaView>
    </Modal>
    <Modal visible={!!addSong} transparent animationType="fade" onRequestClose={() => setAddSong(null)}>
      <Pressable style={s.shade} onPress={() => setAddSong(null)}><View style={s.sheet}>
        <Text style={s.sheetTitle}>Add to playlist</Text>
        {Object.keys(library.playlists).length === 0 && <Text style={s.muted}>Create a playlist first.</Text>}
        {Object.keys(library.playlists).map(name => <TouchableOpacity key={name} style={s.sheetRow}
          onPress={() => addSong && addTo(name, addSong)}><Icon name="playlist" color="#eba068" />
          <Text style={s.rowTitle}>{name}</Text></TouchableOpacity>)}
      </View></Pressable>
    </Modal>
  </SafeAreaView>;
}

const s = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#090d13'}, setup: {flexGrow: 1, justifyContent: 'center', padding: 28},
  mark: {width: 68, height: 68, borderRadius: 18, backgroundColor: '#203449', alignItems: 'center', justifyContent: 'center', marginBottom: 36},
  eyebrow: {color: '#eba068', fontSize: 10, fontWeight: '800', letterSpacing: 2},
  setupTitle: {color: '#f3f5f7', fontSize: 35, fontWeight: '800', letterSpacing: -1, marginTop: 10},
  setupCopy: {color: '#a5b1bc', fontSize: 16, lineHeight: 24, marginTop: 18, marginBottom: 26},
  input: {height: 52, borderRadius: 9, backgroundColor: '#192633', color: '#f3f5f7', paddingHorizontal: 16, marginBottom: 12},
  primary: {height: 52, borderRadius: 26, backgroundColor: '#eba068', alignItems: 'center', justifyContent: 'center'},
  primaryText: {color: '#10151b', fontWeight: '800', fontSize: 15},
  channelRow: {flexDirection: 'row', alignItems: 'center', minHeight: 66, gap: 14},
  channelMark: {width: 44, height: 44, borderRadius: 10, backgroundColor: '#203449', alignItems: 'center', justifyContent: 'center'},
  textButton: {paddingVertical: 16}, accent: {color: '#eba068'}, error: {color: '#ff9c9c', marginTop: 14},
  banner: {backgroundColor: '#33212a', padding: 10},
  bannerText: {color: '#ff9c9c', fontSize: 12},
  header: {paddingHorizontal: 20, paddingTop: 12, paddingBottom: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  headerTitle: {color: '#f3f5f7', fontSize: 27, fontWeight: '800', marginTop: 3},
  iconButton: {width: 38, height: 38, alignItems: 'center', justifyContent: 'center'},
  page: {flex: 1}, content: {paddingHorizontal: 20, paddingBottom: 26},
  welcome: {color: '#f3f5f7', fontSize: 24, fontWeight: '800', marginTop: 22},
  muted: {color: '#8d9ba9', fontSize: 13, marginTop: 5}, section: {color: '#f3f5f7', fontSize: 21, fontWeight: '800', marginTop: 28, marginBottom: 12},
  sectionRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  smallAction: {color: '#a6b2be', fontSize: 12, fontWeight: '700'},
  quickGrid: {flexDirection: 'row', gap: 12}, quickCard: {flex: 1, height: 140, backgroundColor: '#192a3a', borderRadius: 11, padding: 14, justifyContent: 'flex-end'},
  quickName: {color: '#f3f5f7', fontSize: 16, fontWeight: '800', marginTop: 18},
  art: {backgroundColor: '#1d3245', overflow: 'hidden', alignItems: 'center', justifyContent: 'center'},
  row: {minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 9},
  rowCopy: {flex: 1, minWidth: 0}, rowTitle: {color: '#f0f3f6', fontSize: 14, fontWeight: '700'},
  rowSub: {color: '#8e9cab', fontSize: 12, marginTop: 4},
  artistCard: {width: 126, marginRight: 14}, artistName: {color: '#e9eef3', fontSize: 13, fontWeight: '700', marginTop: 9},
  listHeading: {paddingHorizontal: 20}, search: {height: 42, borderRadius: 8, backgroundColor: '#1a2733', color: '#f3f5f7', marginHorizontal: 20, paddingHorizontal: 14},
  list: {paddingHorizontal: 20, paddingTop: 10, paddingBottom: 24}, back: {paddingHorizontal: 20, paddingVertical: 8},
  intro: {color: '#9ba8b5', fontSize: 14, marginBottom: 14}, empty: {color: '#8998a7', textAlign: 'center', marginTop: 50},
  groupRow: {minHeight: 79, flexDirection: 'row', alignItems: 'center', gap: 14},
  createRow: {flexDirection: 'row', alignItems: 'center', marginBottom: 17},
  playlistInput: {flex: 1, height: 44, borderRadius: 8, backgroundColor: '#1a2733', color: '#f3f5f7', paddingHorizontal: 14},
  mini: {backgroundColor: '#1b2b3b', marginHorizontal: 8, borderRadius: 9, minHeight: 62, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 8, overflow: 'hidden'},
  miniProgress: {position: 'absolute', bottom: 0, left: 0, height: 2, backgroundColor: '#eba068'},
  nav: {height: 65, flexDirection: 'row', backgroundColor: '#090d13', paddingTop: 7},
  navItem: {flex: 1, alignItems: 'center', justifyContent: 'center'}, navLabel: {color: '#8393a2', fontSize: 10, fontWeight: '700', marginTop: 3},
  nowScreen: {flex: 1, backgroundColor: '#111d29'}, nowHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18},
  nowBody: {flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 22},
  largeArt: {alignItems: 'center', marginBottom: 40}, nowTitleRow: {flexDirection: 'row', alignItems: 'center', marginBottom: 30},
  nowTitle: {color: '#f3f5f7', fontSize: 23, fontWeight: '800'}, nowArtist: {color: '#a4b1be', fontSize: 15, marginTop: 5},
  progressTouch: {height: 22, justifyContent: 'center'}, progressTrack: {height: 4, borderRadius: 2, backgroundColor: '#526271'},
  progressFill: {height: 4, borderRadius: 2, backgroundColor: '#eba068'}, timeRow: {flexDirection: 'row', justifyContent: 'space-between'},
  progressDot: {position: 'absolute', right: -5, top: -3, width: 10, height: 10,
    borderRadius: 5, backgroundColor: '#f6f6f5'},
  time: {color: '#a1adba', fontSize: 12}, controls: {flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'center', marginTop: 36},
  bigPlay: {width: 68, height: 68, borderRadius: 34, backgroundColor: '#eba068', alignItems: 'center', justifyContent: 'center'},
  queueNote: {color: '#8293a2', textAlign: 'center', fontSize: 12, marginTop: 25},
  shade: {flex: 1, backgroundColor: '#000b', justifyContent: 'flex-end'},
  sheet: {backgroundColor: '#1b2835', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 24, paddingBottom: 42},
  sheetTitle: {color: '#f3f5f7', fontSize: 19, fontWeight: '800', marginBottom: 18},
  sheetRow: {flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52},
});
