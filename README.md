# Telopotify

<p align="center"><img src="TelopotifyApp/assets/telopotify-logo.png" alt="Telopotify owl logo" width="104" /></p>

**Your Telegram music channel, in a music player.** Telopotify indexes song metadata from a channel you can access and streams audio when you press play. Opening a library does not download every song.

The project includes a React Native Windows player, a native iPhone player, and a responsive web player. Windows and web use a Node.js Telegram service. The iPhone player connects to Telegram itself through TDLib and needs no desktop bridge.

> **Status:** Working development software for personal use and a small trusted group. The web-account service is not hardened for open public registration. Included Telegram Desktop API credentials are **test-only**; use your own API ID and hash before distribution.

## Choose what to run

| Experience | Start here | Telegram connection |
| --- | --- | --- |
| Windows app | `npm run app:windows` | Local bridge on the PC |
| Web player, one library | `npm run dev:library` | Same local bridge and collection as Windows |
| Shared remote web player | `npm run dev:library` and `npm run web:gateway` | One library behind a sharing password |
| Separate web accounts | `npm run web:accounts` | Each person signs in to their own Telegram account |
| Native iPhone app | [Build and install the IPA](#iphone-build-and-install) | TDLib on the iPhone; no PC or VPS required |

Commands run from the **repository root** unless a section says to enter `TelopotifyApp/`. Browser-only use needs just the root Node dependencies. Native development also needs the React Native dependencies.

## What is implemented

- **Library:** Telegram login, channel selection, saved catalog, incremental new-post sync, search, recently added/played, artists, albums, liked songs, and playlists. The Windows/web bridge indexes up to 2,000 music messages per channel without downloading their audio.
- **Playback:** On-demand byte-range streaming, seek, play/pause, queue, next/previous, shuffle, repeat, artwork, and a persistent Now Playing area. Windows also has native media controls, speed, sleep timer, and next-track preparation.
- **Storage:** Encrypted/saved Telegram sessions, local collections, a bounded RAM stream cache, and optional selected-song offline downloads on Windows/web. The full channel is never downloaded automatically.
- **iPhone:** Native TDLib access, paged song loading, saved catalog and channel choice, local likes/playlists, and native background-audio and lock-screen integration.

The interfaces are **not fully feature-identical**. The iPhone app is independent of the Windows/web bridge, and local collections do not automatically sync between them. Long-session iPhone background playback and network interruption handling still need broader real-device testing.

## Install

Install [Git](https://git-scm.com/) and **Node.js 24** (recommended; the React Native package requires at least 22.11). Then:

```sh
git clone https://github.com/behrad00rad/telopotify.git
cd telopotify
npm ci
```

For **Windows or native mobile development**, also install:

```sh
cd TelopotifyApp
npm ci
cd ..
```

The web server does **not** require Visual Studio, Xcode, Android Studio, or `TelopotifyApp/node_modules`. It does use the checked-in logo from `TelopotifyApp/assets/`.

### Windows build tools

The native Windows build requires Visual Studio with C++/Windows app tools, the Windows SDK, **PowerShell 7** (`pwsh.exe`), and trusted-app deployment enabled. The launcher targets Windows SDK `10.0.26100.0`; install that SDK or adjust [the launcher](scripts/run-windows.ps1) to your version. This checkout was built with Visual Studio 2026 and that SDK.

## Run the Windows app

From PowerShell in the repository root:

```powershell
npm run app:windows
```

The launcher starts the Telegram bridge and Metro if needed, then builds and opens the app. It reuses running services on later launches. The app discovers its bridge automatically. Sign in to Telegram in the app, choose a channel, and let the first metadata index finish. Keep the bridge and Metro running while using this development build.

To see service errors separately, use two terminals, then retry `npm run app:windows`:

```powershell
# Terminal 1: repository root
npm run dev:library

# Terminal 2: TelopotifyApp directory
cd TelopotifyApp
npm start
```

The bridge is loopback-only at `127.0.0.1:43127`. **Never expose that port publicly.**

## Run the web player

### One local library

```sh
npm run dev:library
```

Open **<http://127.0.0.1:43127/web>** on the same PC. This uses the same Telegram session, channel, likes, and playlists as Windows. The responsive browser player has Home, Songs, Artists, Albums, Liked, Playlists, search, a full Now Playing view, and a bottom queue drawer.

### Share one library with other devices

Keep `npm run dev:library` running. In a second terminal, set a strong password and run the gateway:

```powershell
$env:TELOPOTIFY_WEB_PASSWORD = 'replace-with-a-long-unique-password'
npm run web:gateway
```

On Linux/macOS, use `export TELOPOTIFY_WEB_PASSWORD='...'` before the gateway command. It listens at `127.0.0.1:43128`. Publish **43128**, not 43127, through an HTTPS tunnel or reverse proxy; open the public URL with `/web` appended. Everyone with the password shares one Telegram account and library. Closing the PC or service stops streaming.

### Give each person a separate web account

```sh
npm run web:accounts
```

Open **<http://127.0.0.1:43129/web>** locally. Each person creates a Telopotify web account, signs in to Telegram, and chooses a channel. Their Telegram session, catalog, artwork cache, likes, and playlists are kept separately under ignored `local-data/web-accounts/`. Publish only **43129** through an HTTPS reverse proxy or tunnel. The Node server intentionally binds to `127.0.0.1`, so a reverse proxy should run on the same host.

On a Linux VPS, generate a **stable** 32-byte base64 key once and save it as `TELOPOTIFY_SESSION_KEY` in your host's secret manager or a protected environment file:

```sh
openssl rand -base64 32
# Save the generated value securely, then supply it to this shell:
export TELOPOTIFY_SESSION_KEY='your-saved-base64-key'
npm run web:accounts
```

On Windows, the server creates an ignored `local-data/web-accounts/session.key` when the environment variable is absent. Preserve that file. Changing or losing the key makes saved Telegram sessions unreadable. Back up `local-data/web-accounts/` securely; Git ignores it. Web-account passwords are salted scrypt hashes. Web login cookies expire after seven days and clear on server restart, but saved Telegram sessions remain.

For internet hosting, run Node with a process manager so it restarts after a crash or reboot, use persistent storage, and route a dedicated HTTPS hostname to port 43129. A separate host/domain can keep Telopotify apart from an existing website. This development server permits self-registration, so restrict access to a trusted group until public-account controls and operational security have been reviewed.

### GitHub Codespaces: web-only test

Create a Codespace from this repository, run `npm ci`, add a persistent Codespaces secret called `TELOPOTIFY_SESSION_KEY`, then run `npm run web:accounts`. Forward port **43129** and append `/web` to the HTTPS forwarding URL. A private port requires GitHub login; a public port lets anyone with the URL reach signup. Codespaces stops after inactivity and is a test environment, not 24/7 hosting. Ignored account data disappears if the Codespace is deleted.

## Optional Cloudflare Worker relay

Use this **only with `web:accounts`** when the server can reach Cloudflare over WSS but cannot reach Telegram directly. The Node server starts a loopback SOCKS5 adapter; the Worker relays Telegram protocol bytes to Telegram DC IPv4 addresses on port 443. The browser never receives the relay token. The Worker is neither a general-purpose proxy nor a host for the web app.

Deploy from a machine that can access Cloudflare, in the repository root:

```sh
npx wrangler login
npx wrangler deploy web/telegram-relay-worker.mjs --name telopotify-telegram-relay --compatibility-date 2026-09-29
npx wrangler secret put RELAY_TOKEN --name telopotify-telegram-relay
```

Generate a token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Enter it at Wrangler's secret prompt. Supply the **same** value as `TELOPOTIFY_RELAY_TOKEN` on the web server, plus the Worker's `wss://...workers.dev` URL:

```sh
# Linux shell example; use your own saved secrets and URL.
export TELOPOTIFY_RELAY_URL='wss://your-worker.your-subdomain.workers.dev'
export TELOPOTIFY_RELAY_ENABLED=1
export TELOPOTIFY_RELAY_TOKEN='your-saved-relay-token'
export TELOPOTIFY_SESSION_KEY='your-existing-saved-session-key'
npm run web:accounts
```

Set `TELOPOTIFY_RELAY_ENABLED=0` and **restart** the web server for direct Telegram access; set it to `1` and restart to use the Worker. If unset, a configured relay URL enables it automatically. Startup prints `Telegram relay: on` or `off`. Do not commit either secret. The relay passed local tests but has **not** been verified against a deployed Worker from an Iran VPS; the VPS must be able to reach the Worker over WSS.

## iPhone build and install

The native iPhone app uses TDLib and its own audio module. It does not depend on `web:accounts`, the Windows bridge, or the Cloudflare relay. The [iOS build workflow](.github/workflows/ios-build.yml) runs on GitHub-hosted macOS, compiles a Simulator build, builds an unsigned iPhone app, and uploads `Telopotify-unsigned-iPhone-IPA`.

1. On GitHub, choose **Actions → iOS build → Run workflow** on `main`. Pushing to `main` also starts it.
2. Open the completed run, download the `Telopotify-unsigned-iPhone-IPA` artifact, and extract its ZIP to get the unsigned `.ipa`.
3. Sign and install the IPA with your Apple ID using AltStore/AltServer or another signing method. The unsigned artifact cannot be installed directly.
4. Open the app, sign in to Telegram, choose a channel, and browse.

If you have a Mac with Xcode, install the React Native dependencies above, then:

```sh
bundle install --gemfile=TelopotifyApp/Gemfile
cd TelopotifyApp/ios
bundle exec pod install
cd ..
npm run ios
```

The GitHub workflow is the build path when you have no Mac. Long background sessions, lock-screen controls, VPN changes, and interruptions still need extended listening tests. The iPhone module currently embeds the same test-only Telegram API credentials.

The iOS bundle identifier is `com.behrad00rad.telopotify`. It replaces the React Native template identifier in both Debug and Release. Installing this build alongside an older build with the template identifier creates a separate app; app-private Telegram data does not transfer automatically. A **paid Apple Developer Program membership** is required to register the identifier, create the App Store Connect app record, and distribute through TestFlight. The current GitHub workflow builds an unsigned IPA; signing and TestFlight upload are not configured yet.

## Every project run command

| Directory | Command | Purpose |
| --- | --- | --- |
| Root | `npm ci` | Install bridge, web, and root test dependencies |
| Root | `npm run app:windows` | Start services, build, and open Windows |
| Root | `npm run dev:library` | Local bridge and browser player on 43127 |
| Root | `npm run web:gateway` | Shared password gateway on 43128 |
| Root | `npm run web:accounts` | Separate web accounts on 43129 |
| Root | `npm run spike:telegram` | Interactive one-song Telegram streaming probe |
| Root | `npm test` | Root/shared-core, Telegram service, and web tests |
| Root | `npm run icons:windows` | Regenerate Windows icons from the logo |
| Root | `node scripts/import-desktop-export.mjs "path/to/result.json"` | Import Telegram Desktop JSON metadata without playable audio |
| Root | `node spikes/range-stream/server.mjs "path/to/song.mp3"` | Local-file byte-range streaming experiment |
| `TelopotifyApp/` | `npm ci` | Install React Native dependencies |
| `TelopotifyApp/` | `npm start` | Start Metro |
| `TelopotifyApp/` | `npm run windows` | Standard React Native Windows command; uses the default SDK target |
| `TelopotifyApp/` | `npm run windows:installed-sdk` | Build, deploy, and launch Windows with SDK 10.0.26100 |
| `TelopotifyApp/` | `npm run windows:build:installed-sdk` | Windows build-only check with that SDK |
| `TelopotifyApp/` | `npm run test:windows` | Windows component tests |
| `TelopotifyApp/` | `npm test` | React Native Jest tests |
| `TelopotifyApp/` | `npm run lint` | ESLint |
| `TelopotifyApp/` | `npm run ios` | Build/run on a Mac with Xcode and CocoaPods |
| `TelopotifyApp/` | `npm run android` | Android scaffold; Android playback has not been validated |

The scripts are defined in [root package.json](package.json) and [native package.json](TelopotifyApp/package.json). The installed-SDK Windows variant matches the machine used for development.

## Data, credentials, and limits

| Data | Location / behavior |
| --- | --- |
| Desktop Telegram session | `local-data/telegram.session`, protected with Windows DPAPI for the current user |
| Desktop catalog and collections | `local-data/bridge-library.json` and `local-data/collections.json` |
| Desktop/web cache and selected offline songs | `local-data/artwork/` and `local-data/offline/` |
| Separate web accounts | `local-data/web-accounts/`, including per-user encrypted Telegram sessions |
| iPhone data | App-private iOS and TDLib storage on the device |

`local-data/`, `.env` files, downloaded media, and build output are Git-ignored. **The Node scripts do not automatically load a `.env` file:** set variables in your shell, process manager, or hosting secrets. Do not publish login codes, API hashes, encryption keys, relay tokens, or session files. Sign out clears local session and library data for that client.

The desktop bridge keeps recent streaming bytes in RAM, capped at 32 MiB by default. Set `TELOPOTIFY_CACHE_MB` to `0`–`256` before starting the bridge to change it. Optional offline songs have a separate selectable storage cap. New posts sync from a saved message cursor, including an automatic check about once per minute. A confirmed missing song is skipped rather than blocking the queue.

Artwork loads lazily: Telegram thumbnail first, then MusicBrainz and Cover Art Archive when needed. External matches can be absent or identify another edition. Custom cover URLs and album labels remain local. MusicBrainz's public API is intended for non-commercial use and has rate limits.

### Telegram API credentials

The project uses [Telegram Desktop's published test credentials](https://github.com/telegramdesktop/tdesktop/blob/dev/docs/api_credentials.md), because app registration at [my.telegram.org/apps](https://my.telegram.org/apps) returned a generic `ERROR` during development. For release, follow [Telegram's API ID instructions](https://core.telegram.org/api/obtaining_api_id) and use your own credentials. The Node bridge reads `TELOPOTIFY_API_ID` and `TELOPOTIFY_API_HASH`; the iPhone module still contains test credentials in `TelopotifyApp/ios/TelopotifyApp/TelopotifyTelegram.swift` and needs a production credential path before distribution.

If the app form fails, check whether the account already has an app, try a unique alphanumeric short name, and retry in a fresh browser session. These are diagnostic attempts, not a confirmed fix. Do not share login details or repeatedly submit the form.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Windows says `Unable to find pwsh.exe` | Install PowerShell 7, then retry `npm run app:windows`. |
| Windows stays at Connecting | Run `npm run dev:library` separately and read its error; check port 43127 and Telegram/VPN connectivity. |
| Web loads but playback fails | Keep its Node service running and inspect its terminal output. The one-library player also needs the bridge. |
| Web account forgets Telegram login | Preserve `local-data/web-accounts/` and the same `TELOPOTIFY_SESSION_KEY`. The web-account login itself must be repeated after a server restart. |
| Relay is on but Telegram still fails | Check VPS-to-Worker WSS access, URL, matching tokens, and Worker deployment. Compare with `TELOPOTIFY_RELAY_ENABLED=0` after restarting. |
| Codespace URL is inaccessible to others | Make port 43129 public in Ports, knowing that signup then becomes publicly reachable. |
| iPhone IPA will not install | The CI IPA is unsigned; sign it with AltStore/AltServer or another Apple signing flow. |

Development history and unfinished validation work: [TASKS.md](TASKS.md) · [TASK-01-FINDINGS.md](TASK-01-FINDINGS.md).
