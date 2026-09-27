# Telegram Music Player — Project Tasks

## What we are building

A personal music player built with React Native and React Native Windows, with Windows as the delivery target. iPhone is deferred until the desktop player works. The app connects to a Telegram channel through the user's account, indexes audio metadata, and fetches audio on demand instead of downloading the entire channel.

The first release includes Telegram login, channel selection, a searchable song library, playback and seeking, a queue, shuffle/repeat, favorites, local playlists, and a bounded audio cache. Telegram sessions stay on the device in platform-appropriate secure storage. No hosted backend is planned initially.

Shared code will cover track models, library state, queue behavior, and playlists. Telegram access, audio playback, secure storage, and system media controls will have platform adapters where needed. A single identical implementation across platforms is not assumed.

## Ordered backlog

### T01 — Validate streaming and platform integrations
- [ ] Select compatible React Native / React Native Windows versions and evaluate Telegram client and audio libraries, including licensing.
- [x] Build a minimal Windows proof of concept: authenticate, read one channel audio message, start playback before the full file is fetched, and seek to an unbuffered position. Verified in the running app with a 1,120-song channel and a seek from about 1:42 to 3:26.
- [x] Connect the Windows development probe to Telegram using published test credentials; interactive account login and playback verification remain above.
- [ ] Later: validate the corresponding iPhone path, including continued Telegram fetching and playback with the screen locked, interruption recovery, and lock-screen controls.
- [ ] Later: establish access to an iOS build environment and physical iPhone testing before claiming iOS validation.
- [ ] Document codec support, buffering behavior, cache ownership, and any required native adapters.
- [x] Add a Telegram Desktop JSON export importer for library metadata without downloading media or requiring an API ID.
- [ ] Probe one historical channel message through a bot and measure Bot API file access before choosing that fallback.

Desktop done when: real Telegram audio plays and seeks on Windows before the whole file downloads. iPhone validation is a separate later gate.

### T02 — Scaffold the app and shared architecture
- [x] Set up TypeScript, React Native 0.84.1, and React Native Windows 0.84.0 with native Windows project files. The Windows JavaScript bundle and native Debug x64 solution build with Visual Studio 2026, .NET 10, and Windows SDK 10.0.26100.
- [ ] Later: set up the iOS target and document build requirements.
- [x] Define track and queue models and map TDLib audio messages into track records. Playback, persistence, and secure storage interfaces remain.
- [x] Add library/queue navigation, a dark theme foundation, and development commands. The screen loads a real channel catalog through a loopback-only development bridge; native in-app audio plays and seeks on Windows.

Desktop done when: the app shell launches on Windows. The iOS build path is a later task.

### T03 — Implement Telegram authentication
- [ ] Configure production application API credentials without committing secrets. The development bridge uses Telegram Desktop's public test-only credentials.
- [x] Add phone, verification code, optional email, and two-step password prompts to the Windows app through a token-protected localhost bridge. The new-login flow is tested with a simulated Telegram client; a fresh live login has not been exercised.
- [ ] Store the session securely; support restart, logout, and expired-session recovery. Windows session storage uses current-user DPAPI, including migration of the prior plaintext file. The encrypted session and channel were restored after a live restart. The bridge retries transient restore failures and its logout endpoint removes the session and catalog; live logout and expired-session recovery testing remain.
- [x] Keep verification codes, passwords, and saved session contents out of app and bridge status responses and logs.

Done when: the user can sign in, restart without reauthenticating, and remove the local session by logging out.

### T04 — Select a channel and index its songs
- [x] Let the user select an accessible channel in the Windows app through the local development bridge. The bridge listed 58 accessible channels and indexed the selected 1,120-song channel.
- [ ] Index audio messages incrementally, recording message references and available title, artist, duration, filename, and artwork metadata.
- [ ] Handle incomplete metadata, duplicates, removed messages, and access errors.
- [ ] Persist the index locally and sync new posts without re-fetching the whole history.

Done when: a channel of roughly 1,000 songs can be browsed after indexing without downloading all audio files.

### T05 — Build on-demand playback and bounded caching
- [ ] Implement play/pause, seeking, volume, loading/error states, and retry behavior. Windows play/pause, position display, seeking, volume, end-of-song advance, and native status/error reporting are implemented; recovery still needs work.
- [ ] Fetch audio in chunks through the validated Telegram adapter; refresh stale file references as needed.
- [ ] Limit prefetching and cancel unnecessary requests when tracks change.
- [ ] Enforce a configurable cache limit, protect active playback data, and offer clear-cache controls.
- [ ] Recover from network loss and Telegram rate limits without aggressive retries.

Done when: playback starts before a complete song download, seeking works, and storage remains within the documented cache policy.

### T06 — Design and implement the music interface
- [ ] Create the library, search, now-playing view, persistent player controls, and queue view.
- [ ] Support desktop keyboard/mouse interactions and iPhone touch layouts.
- [ ] Add accessible labels, focus states, readable contrast, and useful empty/loading/error states.
- [ ] Use real indexed metadata, with graceful fallbacks for missing artwork or titles.

Done when: the user can find and play music comfortably at desktop and phone sizes.

### T07 — Add queue, favorites, and playlists
- [ ] Implement next/previous, queue editing, shuffle, and repeat. Next/previous and repeat off/all/one are implemented; queue editing and shuffle remain.
- [ ] Add favorites and create/edit/delete local playlists.
- [ ] Persist user collections and restore the previous queue without unexpected autoplay.

Done when: collections survive restarts and queue behavior remains predictable when tracks become unavailable.

### T08 — Integrate operating-system playback controls
- [ ] Add Windows media keys, system playback information, and a defined minimize/close behavior.
- [ ] Add iPhone background audio, lock-screen controls, and interruption/headphone-disconnection handling.
- [ ] Verify that background streaming continues fetching upcoming audio, not merely playing already buffered bytes.

Done when: playback is usable outside the app and remains reliable through normal device events.

### T09 — Test, package, and deliver
- [ ] Test a large channel, long playback sessions, seeking, cache eviction, network interruptions, and session expiration.
- [ ] Check supported audio formats and report unsupported files clearly.
- [ ] Produce and test a Windows installer.
- [ ] Prepare an appropriate signed iPhone test build when the required Apple build/signing setup is available.
- [ ] Document setup, credentials, cache behavior, and known limitations.

Done when: a fresh Windows installation can sign in and stream the channel, with iPhone results reported separately and accurately.

## Dependencies and scope

T01 → T02 → T03 → T04 → T05. T06 can start after T02 using fixture data; connect it to the real library and player after T04/T05. T07 and T08 depend on the playback foundation. T09 completes delivery.

Initial scope excludes cross-device playlist sync, public multi-user hosting, automatic full-library downloads, lyrics services, and audio effects. These can be separate follow-up tasks.

Status: T01 desktop streaming gate is verified. The loopback bridge indexed 1,120 real songs, served a mid-file range, and the running Windows app reported playback and advanced to an unbuffered seek position. T02's Windows app shell builds, deploys, and runs. The Windows launcher starts a fixed-port local bridge and the app discovers and reconnects to it automatically. T03/T04 have in-app sign-in prompts, a channel picker, and Windows DPAPI session storage. The encrypted session and selected 1,120-song channel restored after a live restart; a fresh login/logout test, incremental syncing, and a production Telegram adapter remain. T05/T07 include volume, repeat off/all/one, and native end-of-song advance; the native build passes, but these interactions still need live listening verification. T06 has a redesigned library, search, queue, and persistent player; desktop interaction and accessibility polish still need live review. See `TASK-01-FINDINGS.md`.
