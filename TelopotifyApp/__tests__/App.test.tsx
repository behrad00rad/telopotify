/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Image, Linking, NativeModules, Platform } from 'react-native';
import App from '../App';
import { Icon } from '../src/components/Icon';

test('renders correctly', async () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  try {
    await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<App />); });
  } finally {
    await ReactTestRenderer.act(async () => { renderer?.unmount(); });
    fetchMock.mockRestore();
  }
});

test('connects automatically to the local bridge and loads a selected channel', async () => {
  const originalPlatform = Platform.OS;
  (Platform as { OS: string }).OS = 'windows';
  let selected = false;
  let synced = false;
  let revision = 0;
  let cacheBytes = 1024;
  let savedCollections = { channelId: '-100123', favorites: [] as string[], playlists: [] as object[],
    queue: { trackIds: [] as string[], currentTrackId: null as string | null, repeat: 'off' } };
  const originalAudio = NativeModules.TelopotifyAudio;
  NativeModules.TelopotifyAudio = {
    play: jest.fn(), pause: jest.fn(), resume: jest.fn(), stop: jest.fn(),
    setSpeed: jest.fn(), setNext: jest.fn(),
    getStatus: () => 'playing', getPosition: () => 0, getDuration: () => 120,
  };
  const openMock = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url);
    let data: object;
    if (path.endsWith('/bootstrap')) data = { address: 'http://127.0.0.1:43127?token=testtoken' };
    else if (path.includes('/status?')) {
      expect(path).toBe('http://127.0.0.1:43127/status?token=testtoken');
      data = { authenticated: true, online: selected,
      step: 'authorized', error: '', channel: selected ? 'My Music' : '', trackCount: selected ? 1 : 0,
      selected, indexing: false, syncing: false, catalogRevision: revision, lastSyncedAt: null, syncError: '',
      cache: { bytes: cacheBytes, limitBytes: 32 * 1048576, chunks: cacheBytes ? 1 : 0 }, unavailableTrackIds: [] };
    }
    else if (path.includes('/channels/select?')) {
      expect(options?.method).toBe('POST');
      selected = true;
      revision++;
      data = { channel: 'My Music', count: 1 };
    } else if (path.includes('/channels?')) data = { channels: [{ index: 0, title: 'My Music', selected: false }] };
    else if (path.includes('/library/sync?')) {
      expect(options?.method).toBe('POST');
      synced = true;
      revision++;
      data = { added: 1, count: 2, busy: false };
    } else if (path.includes('/cache/clear?')) {
      expect(options?.method).toBe('POST');
      cacheBytes = 0;
      data = { bytes: 0, limitBytes: 32 * 1048576, chunks: 0 };
    } else if (path.includes('/collections?')) {
      if (options?.method === 'POST') savedCollections = JSON.parse(String(options.body));
      data = savedCollections;
    } else if (path.includes('/library?')) data = { channel: selected ? 'My Music' : '',
      channelId: selected ? '-100123' : null, online: selected, catalogRevision: revision,
      unavailableTrackIds: [],
      tracks: selected ? [{ messageId: 7, title: 'Song', artist: 'Artist',
        durationSeconds: 120, fileSize: 1000, mimeType: 'audio/mpeg' },
      ...(synced ? [{ messageId: 8, title: 'New Song', artist: 'Artist',
        durationSeconds: 90, fileSize: 800, mimeType: 'audio/mpeg' }] : [])] : [] };
    else throw new Error(`Unexpected request: ${path}`);
    return { ok: true, json: async () => data } as Response;
  });

  let renderer!: ReactTestRenderer.ReactTestRenderer;
  try {
    await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<App />); });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Choose My Music' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Choose My Music' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Play Song' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Play Song' }).props.onPress();
    });
    expect(NativeModules.TelopotifyAudio.play).toHaveBeenCalledWith(
      expect.stringContaining('/audio/7?'), 'Song', 'Artist');
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Recent' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Play Song' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Tracks' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Duration: Any' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Duration: < 3 min' })).toBeTruthy();
    const pause = renderer.root.findByProps({ accessibilityLabel: 'Pause selected song' });
    expect(pause.findByType(Icon).props.name).toBe('pause');
    await ReactTestRenderer.act(async () => { await pause.props.onPress(); });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Play selected song' })
      .findByType(Icon).props.name).toBe('play');
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Play selected song' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Pause selected song' })
      .findByType(Icon).props.name).toBe('pause');
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Sync new songs' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Play New Song' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Play New Song next' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Pause selected song' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Clear streaming cache' }).props.onPress();
    });
    expect(cacheBytes).toBe(0);
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Open now playing' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Toggle playback from now playing' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Edit current song cover' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Custom cover URL' }).props
        .onChangeText('https://example.com/song-cover.jpg');
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Save custom cover' }).props.onPress();
    });
    expect(renderer.root.findAllByType(Image).some(node =>
      node.props.source?.uri === 'https://example.com/song-cover.jpg')).toBe(true);
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Playback speed 1x' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Sleep timer off' }).props.onPress();
    });
    expect(NativeModules.TelopotifyAudio.setSpeed).toHaveBeenCalledWith(1.25);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Sleep timer 15 minutes remaining' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Artists' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Open Artist' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Play Song' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Albums' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Open Unsorted tracks' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Set album for Song' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Album name' }).props.onChangeText('Night Drive');
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Save album name' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Back to groups' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Open Night Drive' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Tracks' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Add favorite Song' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Playlists' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'New playlist name' }).props.onChangeText('Mix');
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Create playlist' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Tracks' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Add Song to playlist' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Add to playlist Mix' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Close playlist picker' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Playlists' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Play Song' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Queue' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Move New Song up' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Pause selected song' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Remove New Song from queue' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Play Song' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 500));
    });
    expect(savedCollections.favorites).toContain('7');
    expect((savedCollections as typeof savedCollections & { recentTrackIds: string[] }).recentTrackIds).toContain('7');
    expect(savedCollections.playlists).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Mix', trackIds: ['7'] }),
    ]));
    expect((savedCollections as typeof savedCollections & { albumOverrides: Record<string, string> })
      .albumOverrides['7']).toBe('Night Drive');
    expect((savedCollections as typeof savedCollections & { coverOverrides: Record<string, string> })
      .coverOverrides['7']).toBe('https://example.com/song-cover.jpg');
    const playCalls = (NativeModules.TelopotifyAudio.play as jest.Mock).mock.calls.length;
    await ReactTestRenderer.act(async () => { renderer.unmount(); });
    await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<App />); });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Favorites' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Play Song' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Albums' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Open Night Drive' })).toBeTruthy();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Recent' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Play Song' })).toBeTruthy();
    expect((NativeModules.TelopotifyAudio.play as jest.Mock).mock.calls.length).toBe(playCalls);
  } finally {
    await ReactTestRenderer.act(async () => { renderer?.unmount(); });
    fetchMock.mockRestore();
    openMock.mockRestore();
    NativeModules.TelopotifyAudio = originalAudio;
    (Platform as { OS: string }).OS = originalPlatform;
  }
});

test('starts sign-in in the app and shows the Telegram code prompt', async () => {
  let step = 'phone';
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url);
    let data: object;
    if (path.endsWith('/bootstrap')) data = { address: 'http://127.0.0.1:43127?token=testtoken' };
    else if (path.includes('/status?')) data = { authenticated: false, online: false,
      step, error: '', channel: '', trackCount: 0, selected: false, indexing: false };
    else if (path.includes('/auth/start?')) {
      expect(options?.method).toBe('POST');
      expect(JSON.parse(String(options?.body))).toEqual({ phone: '+15555550123' });
      step = 'code';
      data = { step };
    } else if (path.includes('/library?')) data = { channel: '', online: false, tracks: [] };
    else throw new Error(`Unexpected request: ${path}`);
    return { ok: true, json: async () => data } as Response;
  });
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  try {
    await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<App />); });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Telegram phone number' }).props
        .onChangeText('+15555550123');
    });
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Continue Telegram sign-in' }).props.onPress();
    });
    const codeInput = renderer.root.findByProps({ accessibilityLabel: 'Telegram verification input' });
    expect(codeInput.props.secureTextEntry).toBe(true);
  } finally {
    await ReactTestRenderer.act(async () => { renderer?.unmount(); });
    fetchMock.mockRestore();
  }
});
