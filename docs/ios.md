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

The iOS background audio capability, native AVPlayer module, and a phone-side
TDLib sign-in module are in the repository. The iPhone app opens its own
Telegram session in private app storage, independently of Windows, lists
channels for selection, and pages through audio message metadata without
downloading the files. The player requests bounded song byte ranges from TDLib
as needed, including after a seek. The native queue now advances across loaded
songs while JavaScript is suspended, with next/previous lock-screen commands.
The iPhone library includes songs, artists, caption-labeled albums, likes,
playlists stored on the phone, and Telegram cover thumbnails. Telegram audio
metadata has no reliable album-name field; songs without an `Album:` caption
are grouped as untagged. Multi-song background playback and network recovery
still need device testing.
Telegram's public sample API credentials are only for development. A dedicated
API ID/hash are required before distribution.

## Device acceptance checks

- Sign in, pick the music channel, and load metadata with the Windows PC off.
- Start a song over cellular or Wi-Fi, lock the phone, and keep listening.
- Pause, resume, seek, and skip using the lock screen and headphones.
- Leave the app in the background through several tracks without JavaScript
  staying active.
- Disconnect and reconnect the VPN/network; playback recovers without signing
  out, and cached music remains available.
- Confirm the on-device cache stays within its configured size.

GitHub Actions compiles an unsigned iOS Simulator build on a hosted Mac.
It also packages an unsigned iPhone IPA artifact. On Windows, AltStore Classic
can sign and sideload this IPA with a free Apple Account; the app must be
refreshed periodically (normally every seven days). Download the artifact
from the latest successful **iOS build** workflow run, extract its ZIP, and
open the IPA in AltStore on the iPhone. This path still requires a real iPhone
and Windows AltServer setup. Alternatively, Xcode on a Mac can install a
development build, and a paid Apple Developer Program account can distribute
signed builds through TestFlight. The simulator build alone cannot be installed
on a phone.
