import React, { useEffect, useState } from 'react';
import {
  NativeEventEmitter, NativeModules, SafeAreaView, StatusBar, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';

type AuthState = { state: string; error?: string };
type TelegramModule = {
  start(): Promise<AuthState>;
  getState(): Promise<AuthState>;
  sendPhone(phone: string): Promise<unknown>;
  sendCode(code: string): Promise<unknown>;
  sendPassword(password: string): Promise<unknown>;
};

const telegram = NativeModules.TelopotifyTelegram as TelegramModule;

export default function IOSApp() {
  const [auth, setAuth] = useState<AuthState>({ state: 'starting' });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
      <Text style={styles.title}>{ready ? 'Connected to Telegram' : 'Your music, anywhere.'}</Text>
      <Text style={styles.description}>{ready
        ? 'Your Telegram session is stored on this iPhone. Channel browsing and streaming are coming next.'
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
});
