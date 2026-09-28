import React, { useEffect, useState } from 'react';
import {
  NativeEventEmitter, NativeModules, SafeAreaView, ScrollView, StatusBar, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';

type AuthState = { state: string; error?: string };
type Channel = { id: string; title: string };
type TelegramModule = {
  start(): Promise<AuthState>;
  getState(): Promise<AuthState>;
  sendPhone(phone: string): Promise<unknown>;
  sendCode(code: string): Promise<unknown>;
  sendPassword(password: string): Promise<unknown>;
  listChannels(): Promise<Channel[]>;
  selectChannel(id: string): Promise<Channel>;
  getSelectedChannel(): Promise<string | null>;
};

const telegram = NativeModules.TelopotifyTelegram as TelegramModule;

export default function IOSApp() {
  const [auth, setAuth] = useState<AuthState>({ state: 'starting' });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);

  useEffect(() => {
    const events = new NativeEventEmitter(NativeModules.TelopotifyTelegram);
    const subscription = events.addListener('telegramState', (next: AuthState) => {
      setAuth(next);
      setError(next.error ?? '');
      setInput('');
    });
    telegram.start().then(setAuth).catch(e => setError(String(e)));
    return () => subscription.remove();
  }, []);

  const state = auth.state;
  const ready = state === 'authorizationStateReady';
  const phone = state === 'authorizationStateWaitPhoneNumber';
  const code = state === 'authorizationStateWaitCode';
  const password = state === 'authorizationStateWaitPassword';
  const acceptsInput = phone || code || password;
  const prompt = phone ? 'Your Telegram phone number' : code ? 'Code from Telegram' : 'Two-step verification password';

  async function refreshChannels() {
    setLoadingChannels(true);
    setError('');
    try {
      const [saved, available] = await Promise.all([
        telegram.getSelectedChannel(), telegram.listChannels(),
      ]);
      setSelected(saved);
      setChannels(available);
    } catch (e) { setError(String(e)); }
    finally { setLoadingChannels(false); }
  }

  useEffect(() => {
    if (ready) { refreshChannels(); }
  }, [ready]);

  async function chooseChannel(channel: Channel) {
    try {
      await telegram.selectChannel(channel.id);
      setSelected(channel.id);
      setError('');
    } catch (e) { setError(String(e)); }
  }

  async function submit() {
    if (!input.trim() || busy) { return; }
    setBusy(true);
    setError('');
    try {
      if (phone) { await telegram.sendPhone(input.trim()); }
      else if (code) { await telegram.sendCode(input.trim()); }
      else if (password) { await telegram.sendPassword(input); }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  return <SafeAreaView style={styles.screen}>
    <StatusBar barStyle="light-content" />
    <View style={styles.content}>
      <View style={styles.mark}><Text style={styles.markText}>T</Text></View>
      <Text style={styles.eyebrow}>TELOPOTIFY FOR IPHONE</Text>
      <Text style={styles.title}>{ready ? 'Choose your channel' : 'Your music, anywhere.'}</Text>
      <Text style={styles.description}>{ready
        ? 'Your Telegram session lives on this iPhone. Pick the channel that holds your songs.'
        : acceptsInput ? prompt : 'Preparing a direct connection to Telegram on this iPhone…'}</Text>
      {acceptsInput && <>
        <TextInput
          autoCapitalize="none" autoCorrect={false} keyboardType={phone ? 'phone-pad' : 'default'}
          secureTextEntry={password} placeholder={prompt} placeholderTextColor="#718092"
          style={styles.input} value={input} onChangeText={setInput} onSubmitEditing={submit}
        />
        <TouchableOpacity accessibilityRole="button" disabled={busy || !input.trim()}
          style={[styles.button, (busy || !input.trim()) && styles.disabled]} onPress={submit}>
          <Text style={styles.buttonText}>{busy ? 'Connecting…' : 'Continue'}</Text>
        </TouchableOpacity>
      </>}
      {!!error && <Text style={styles.error}>{error}</Text>}
      {ready && <>
        <ScrollView style={styles.channelList} contentContainerStyle={styles.channelListContent}>
        {channels.map(channel => <TouchableOpacity key={channel.id} accessibilityRole="button"
          style={styles.channel} onPress={() => chooseChannel(channel)}>
          <View style={styles.channelAvatar}><Text style={styles.channelAvatarText}>{channel.title.slice(0, 1).toUpperCase()}</Text></View>
          <Text style={styles.channelTitle} numberOfLines={1}>{channel.title}</Text>
          {selected === channel.id && <Text style={styles.check}>✓</Text>}
        </TouchableOpacity>)}
        </ScrollView>
        <TouchableOpacity accessibilityRole="button" onPress={refreshChannels}>
          <Text style={styles.retry}>{loadingChannels ? 'Loading channels…' : 'Refresh channels'}</Text>
        </TouchableOpacity>
        {selected && <Text style={styles.note}>Channel selected. Song indexing and streaming are the next step.</Text>}
      </>}
      {!acceptsInput && !ready && <TouchableOpacity accessibilityRole="button" onPress={() => {
        telegram.getState().then(setAuth).catch(e => setError(String(e)));
      }}><Text style={styles.retry}>Check connection</Text></TouchableOpacity>}
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#080d14' },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 30 },
  mark: { width: 64, height: 64, borderRadius: 19, backgroundColor: '#173147',
    alignItems: 'center', justifyContent: 'center', marginBottom: 48 },
  markText: { color: '#f5f7f8', fontSize: 33, fontWeight: '700' },
  eyebrow: { color: '#ed9b58', fontSize: 11, fontWeight: '700', letterSpacing: 2.2, marginBottom: 14 },
  title: { color: '#f6f7f8', fontSize: 34, fontWeight: '700', letterSpacing: -1.2, lineHeight: 39 },
  description: { color: '#a4afbb', fontSize: 16, lineHeight: 24, marginTop: 16, marginBottom: 30 },
  input: { color: '#f6f7f8', backgroundColor: '#16212d', borderRadius: 12,
    paddingHorizontal: 17, height: 54, fontSize: 16, marginBottom: 14 },
  button: { backgroundColor: '#ed9b58', borderRadius: 12, height: 54,
    alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#10151c', fontSize: 16, fontWeight: '700' },
  error: { color: '#ff9b9b', fontSize: 14, marginTop: 16 },
  retry: { color: '#ed9b58', fontSize: 15, fontWeight: '600' },
  channel: { flexDirection: 'row', alignItems: 'center', minHeight: 62, marginBottom: 8 },
  channelList: { flexGrow: 0, maxHeight: 360, marginBottom: 20 },
  channelListContent: { paddingBottom: 4 },
  channelAvatar: { width: 42, height: 42, borderRadius: 10, backgroundColor: '#243f55',
    alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  channelAvatarText: { color: '#eff5fa', fontSize: 18, fontWeight: '700' },
  channelTitle: { color: '#f6f7f8', fontSize: 16, flex: 1 },
  check: { color: '#ed9b58', fontSize: 22, marginLeft: 12 },
  note: { color: '#a4afbb', marginTop: 28, fontSize: 14, lineHeight: 21 },
});
