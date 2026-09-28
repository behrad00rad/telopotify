# Standalone iPhone app

The iPhone app reuses the React Native screens, but it must not call the Windows
loopback bridge (`127.0.0.1:43127`). The phone owns its own Telegram session,
catalog, media cache, and playback queue.

## Architecture

1. **Telegram on-device:** link TDLib into the iOS target and expose a small
   native module for authorization, channel selection, song metadata, and file
   ranges. Keep the TDLib database and session in the app's private storage.
   A Windows session file cannot be copied into the iPhone app.
2. **Streaming:** let an `AVAssetResourceLoader` request only the byte ranges
   needed by the current song from TDLib's `downloadFile` offset/limit API.
   Keep a bounded cache and prefetch a small amount of the next song. Indexing
   1,000 songs must read metadata only; it must not download 1,000 audio files.
3. **Playback:** use the native `TelopotifyAudio` player, `AVAudioSession.playback`,
   background audio mode, Now Playing metadata, and lock-screen commands.
   The native layer must own enough queue state to advance songs while React
   Native JavaScript is suspended.
4. **App integration:** route the existing library, auth, collections, artwork,
   and playback UI through platform-specific data providers. Windows keeps its
   current bridge; iOS uses TDLib directly. Add iPhone-sized layouts and secure
   session storage.

The iOS background audio capability and a native AVPlayer module are in the
repository. The module currently accepts playable URLs; the TDLib-backed
resource loader and direct iOS data provider are still required before this is
a standalone iPhone player. Telegram's public sample API credentials are only
for development. A dedicated API ID/hash are required before distribution.

## Device acceptance checks

- Sign in, pick the music channel, and load metadata with the Windows PC off.
- Start a song over cellular or Wi-Fi, lock the phone, and keep listening.
- Pause, resume, seek, and skip using the lock screen and headphones.
- Leave the app in the background through several tracks without JavaScript
  staying active.
- Disconnect and reconnect the VPN/network; playback recovers without signing
  out, and cached music remains available.
- Confirm the on-device cache stays within its configured size.

iOS compilation, signing, simulator use, and device testing require Xcode on a
Mac. Repository work can continue on Windows, but these checks must wait for
Mac access.
