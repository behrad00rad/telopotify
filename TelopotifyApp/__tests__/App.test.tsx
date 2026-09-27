/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Linking, NativeModules, Platform } from 'react-native';
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
  const originalAudio = NativeModules.TelopotifyAudio;
  NativeModules.TelopotifyAudio = {
    play: jest.fn(), pause: jest.fn(), resume: jest.fn(), stop: jest.fn(),
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
      selected, indexing: false, syncing: false, catalogRevision: revision, lastSyncedAt: null, syncError: '' };
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
    } else if (path.includes('/library?')) data = { channel: selected ? 'My Music' : '',
      channelId: selected ? 'channel-1' : null, online: selected, catalogRevision: revision,
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
    expect(renderer.root.findByProps({ accessibilityLabel: 'Pause selected song' })).toBeTruthy();
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
