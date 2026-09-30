# Telegram Music Player

Windows-first React Native music player for streaming audio from a Telegram channel. iPhone support is deferred until the desktop player works.

The desktop streaming proof is working. See [TASKS.md](TASKS.md) for the backlog and [TASK-01-FINDINGS.md](TASK-01-FINDINGS.md) for validation details. `TelopotifyApp/src/core/` contains tested, platform-independent track mapping, search, and queue logic. `TelopotifyApp/App.tsx` browses a real channel through a local development bridge, and the React Native Windows app plays and seeks real Telegram audio.

The React Native app lives in `TelopotifyApp/`. Its Windows JavaScript bundle and native Debug x64 solution build successfully on this machine with Visual Studio 2026, .NET 10, and Windows SDK 10.0.26100. Because React Native Windows defaults to SDK 10.0.22621, use `npm run windows:build:installed-sdk` for a build-only check here. `npm run windows:installed-sdk` also deploys and launches after Windows trusted-app deployment is enabled. The root `package.json` is for the Telegram streaming probe and core tests.

## Run on this Windows PC

From PowerShell in `D:\musicplayer`, run:

```powershell
npm run app:windows
```

The launcher starts the local Telegram bridge and React Native development server if needed, then builds and opens the Windows app. The app finds the bridge and reconnects automatically; no address needs to be copied. Keep the bridge and development server running for streaming; the launcher reuses them on later runs. If this is a fresh checkout, run `npm ci` in both `D:\musicplayer` and `D:\musicplayer\TelopotifyApp` first.

React Native Windows needs PowerShell 7 (`pwsh.exe`). The launcher finds the standard installation or the copy bundled with Codex on this PC and adds it to its own process PATH. It reports a clear error if neither is available.

## Responsive web player

Start the Telegram service with `npm run dev:library`, then open
`http://127.0.0.1:43127/web` on the same PC. The browser player has Home,
Songs, Artists, Albums, Liked, Playlists, search, artwork, and a Now Playing
view. The browser also has a bottom queue drawer, shuffle, and repeat. It uses the saved local Telegram session and streams audio by range;
opening the page does not download the whole channel. The browser and Windows
app share the channel, likes, and playlists stored by the local service.

To use it from other devices, keep the Windows PC and Telegram service running.
Set a strong sharing password and start the separate gateway:

```powershell
$env:TELOPOTIFY_WEB_PASSWORD = 'your-long-unique-password'
npm run web:gateway
```

The gateway listens only on `127.0.0.1:43128`. Publish **that port only**
through an HTTPS tunnel, such as [Tailscale Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel)
(`tailscale funnel 43128`),
and open the tunnel's `/web` URL on the other device. The gateway asks for the
sharing password before it exposes music metadata or audio. Keep port `43127`
private; it is the local Windows-app service. Everyone with the sharing password
uses the same channel, likes, and playlists. Closing the PC or the service
stops remote streaming. The iPhone native app remains independent of the PC.

### Separate web accounts (development)

Run `npm run web:accounts` and open `http://127.0.0.1:43129/web`. Each person
creates a web account, then signs in to their own Telegram account and chooses
their own channel. Accounts have separate Telegram sessions, catalogs, artwork,
likes, and playlists in ignored `local-data/web-accounts/`. The server listens
on localhost; use an HTTPS tunnel or reverse proxy to reach it from other devices.
Do not expose the local bridge ports. Use persistent storage for
`local-data/web-accounts/` on a hosted server.

The included Telegram Desktop API credentials remain **test-only**. Before
releasing a public service, set `TELOPOTIFY_API_ID` and `TELOPOTIFY_API_HASH`
to your own app credentials. The local Windows desktop bridge uses DPAPI;
the multi-user web server creates an ignored `local-data/web-accounts/session.key`
on Windows and uses it to encrypt its Telegram sessions without PowerShell.
Keep this file with the account data across restarts. On Linux or other hosted systems, set a stable
`TELOPOTIFY_SESSION_KEY` to a base64-encoded 32-byte secret before starting the
server; preserve that key securely or saved Telegram sessions cannot be
restored. Web account passwords are stored as salted scrypt hashes. Web login
cookies last seven days but become invalid when the server restarts, so users log
back into their web accounts; their saved Telegram sessions remain. This is a
development implementation for a small trusted group, not a production-ready
public sign-up service.

### Telegram relay for a server where Telegram TCP is blocked

`web/telegram-relay-worker.mjs` is a Cloudflare Worker that accepts authenticated
WebSocket connections and opens raw TCP connections **only** to Telegram DC IPv4
addresses on port 443. The web server starts a loopback-only SOCKS5 adapter and
passes it to each account's Telegram bridge. The browser still connects to your
normal web server; it never sees the relay token. This is for the multi-user web
server, not a general-purpose proxy.

Deploy the Worker from a machine that can reach Cloudflare:

```sh
npx wrangler login
npx wrangler deploy web/telegram-relay-worker.mjs --name telopotify-telegram-relay --compatibility-date 2026-09-29
npx wrangler secret put RELAY_TOKEN --name telopotify-telegram-relay
```

Generate a random token of at least 32 URL-safe characters (`node -e
"console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`),
enter it when Wrangler prompts, and store the same value as
`TELOPOTIFY_RELAY_TOKEN` on the VPS. Set `TELOPOTIFY_RELAY_URL` to the deployed
Worker's `wss://...workers.dev` URL. Set `TELOPOTIFY_RELAY_ENABLED=1` and run
`npm run web:accounts` on the VPS with the existing stable
`TELOPOTIFY_SESSION_KEY`. To switch to a direct Telegram connection, set
`TELOPOTIFY_RELAY_ENABLED=0` and restart the web server; set it back to `1`
and restart to use the Worker again. If the switch is unset, a configured
relay URL enables it automatically. The server prints the active mode at
startup. Do not commit either secret.
The VPS must be able to establish HTTPS/WebSocket connections to the Worker;
some networks block that too. Cloudflare can see the destination DC and traffic
timing, although the Telegram protocol remains encrypted end-to-end. Test this
with your own account before relying on it; the relay has not been exercised
against a deployed Worker from an Iran VPS.

## Current experiment

The local byte-range playback experiment uses only Node.js:

```powershell
node --test --test-isolation=none TelopotifyApp/src/core/*.test.mjs spikes/range-stream/*.test.mjs spikes/telegram-client/*.test.mjs
node spikes/range-stream/server.mjs "C:\path\to\a\song.mp3"
```

Open the printed localhost URL, play the song, and seek. The console logs the ranges requested by the player. This experiment reads a local file; the Telegram-backed development bridge is described below.

## GitHub hygiene

The repository ignores `.env` files, Telegram sessions, downloaded media, and caches. Keep Telegram API credentials and login details in local storage only. Inspect `git status` and the staged diff before publishing.

## Telegram app registration

Telegram's [official instructions](https://core.telegram.org/api/obtaining_api_id) require signing in at [my.telegram.org](https://my.telegram.org), opening **API development tools**, and creating an application to obtain an API ID and hash. An account can have only one API ID. The current blocker is a generic `ERROR` alert after submitting the application form; Telegram's guide does not identify a cause for that alert.

Reasonable diagnostic attempts are to check whether the account already has an application, retry with a unique short name made of plain letters and digits and **Desktop** as the platform, and try the form in a fresh browser session or on the phone. These are troubleshooting attempts, not a confirmed fix. Avoid repeated rapid submissions. If the alert persists, record the browser, form fields excluding private information, and whether the same account works on another device. Do not share API hashes, sign-in codes, or session files.

The sample API credentials in Telegram's open-source clients are limited to testing and [must not be used for a released app](https://core.telegram.org/api/obtaining_api_id).

## Test one real song with Telegram's development credentials

The `spikes/telegram-client/` probe uses the [public TEST ONLY credentials published in Telegram Desktop's source](https://github.com/telegramdesktop/tdesktop/blob/dev/docs/api_credentials.md). It signs in locally, lists channels and music messages, and serves one selected song in a local browser player using small byte-range requests. It does not download the full channel.

```powershell
npm ci
npm run spike:telegram
```

Enter the phone number, login code, and two-step password **in the terminal only**. On Windows, the session is encrypted for your Windows account in ignored `local-data/telegram.session`; delete that file to require a fresh sign-in. Select a channel and song by number, then open the printed localhost URL and test play and seek. This development probe is not yet the React Native Windows app. Teleproto's chunk iterator may fail on some Telegram CDN redirects; record the error if that happens. The published credentials are limited and unsuitable for release.

## Browse your channel in the development app

Run the local bridge from the repository root:

```powershell
npm run dev:library
```

The bridge binds to `127.0.0.1:43127` and exposes a loopback-only discovery endpoint for the Windows app. The app obtains the current access token there automatically, including after a bridge restart. Keep the bridge terminal running if you start it manually. If there is no saved session, enter your phone number, Telegram code, and any requested two-step password or email code in the app. Then choose a channel; indexing reads up to 2,000 music-message records without downloading audio. The earlier plaintext development session is migrated in place to Windows DPAPI encryption, and transient Telegram connection failures are retried with bounded backoff. The encrypted session and selected 1,120-song channel were restored successfully after a live bridge restart. **Sign out** removes the local session and saved catalog. The sign-in prompts have automated tests, but a fresh live login and logout have not been exercised.

The library has a channel collection header, search, a song table, a queue view, and persistent player controls. Clicking a song starts playback. The Windows app has a native MediaPlayer adapter with play/pause, playback status, click-to-seek, volume, end-of-song advance, and repeat off/all/one. The play button shows a pause icon while a song is opening, buffering, or playing, and switches back when paused or stopped. Interface controls use Windows icon glyphs instead of emoji. Playback and seeking were verified against real Telegram audio; the new end-of-song and volume controls have passed the native build but still need live listening verification. On other platforms, Play opens the browser, but automatic bridge discovery currently works only on the same Windows PC. Each stream request retrieves at most 512 KB from Telegram. The bridge retries transient chunk failures and returns HTTP 502 when Telegram stays unavailable. It saves the last indexed song metadata and the newest indexed message ID to ignored `local-data/bridge-library.json`. After reconnecting, the bridge checks only newer channel posts, automatically every minute or when **Sync** is clicked; a refresh keeps the current playback and queue. Historical songs resolve their Telegram message only when played, so restart does not re-index the whole catalog. If Telegram cannot connect on the next launch, the app can browse the saved catalog while playback is disabled. The ignored, DPAPI-encrypted Telegram session remains on this Windows account. Do not publish the bridge connection address or expose the local port to other devices. The public test-only Telegram API credentials still make this bridge unsuitable for distribution.

The bridge keeps recent streaming ranges in RAM, capped at 32 MiB by default; only songs explicitly saved for offline use are stored on disk. Set `TELOPOTIFY_CACHE_MB` to an integer from 0 to 256 before starting the bridge to change the RAM cap (0 disables it). The player shows usage and a **Clear** control. The RAM cache clears on bridge restart, channel change, and sign-out; its oldest ranges are evicted first, preferring to keep the currently requested song. A deleted song is marked unavailable when Telegram confirms its message is gone, and the player skips it in the queue. Streaming errors show a Retry control. A real network outage and removed-song scenario still need live testing.

Favorites, named playlists, and the edited play queue are saved per channel in ignored `local-data/collections.json`. Star a song to add it to Favorites, use its playlist icon to add or remove it from a playlist, and use **Play next** to move it after the current song. The Queue view lets you move songs up or down, remove them, or clear the queue. Playlists can be created, renamed, played, and deleted. The previous queue and repeat mode restore after restart without starting playback. **Sign out** removes these local collections along with the session and catalog. This development bridge stores collection metadata locally; it does not sync it to Telegram or across devices.

The library and playlists now have Shuffle actions; **Shuffle next** rearranges only upcoming queue entries, keeping the current song in place. Queue rows have a drag handle alongside the move buttons. Library and Favorites offer artist text filtering, duration and file-type filters, and sorting by newest, title, artist, or duration. Recently played songs are saved per channel (up to 50 entries). Windows media keys and the system playback panel use the native MediaPlayer, including track title and artist and next/previous commands. The native build passes; media-key behavior still needs a live Windows check.

On this machine, the user approved enabling `AllowAllTrustedApps`, and React Native deployed and launched the app successfully. The Visual Studio installer requested a restart, but the build and launch succeeded without one.

## Library views and offline listening

The Windows interface has a Home page, searchable Tracks, Artists, Albums, Liked songs, Playlists, Queue, Recent, and a full Now Playing view. The persistent player opens Now Playing when clicked and keeps Like and Add to playlist beside the current song. The desktop layout uses a dark navigation rail and a compact playback bar. Artist groups come from the indexed artist metadata. Telegram's current catalog does not provide album names, so use **Set album** on a track to give it a local album label; unlabeled songs appear in **Unsorted tracks**. Album labels stay with the channel's local collections and are removed on sign-out.

Artwork loads only when a cover is visible. The bridge first tries the song's Telegram document thumbnail, then Telegram's album-thumbnail service. If neither has an image, it sends the song title and artist to MusicBrainz to identify a release and asks the Cover Art Archive for its front cover. A locally assigned album label narrows the release choice. Automatic matching is conservative, but can still choose the wrong edition or find nothing. Open **Now playing → Edit cover** to paste an HTTPS image URL or clear that field to return to automatic artwork. These per-song overrides are saved with local collections. Resolved images and misses are cached under ignored `local-data/artwork/` (up to 128 MiB of images); sign-out removes them. This does not download song audio. MusicBrainz's public API is for non-commercial use, requires an identifying User-Agent, and is limited to about one lookup per second.

The player can save individual songs or a playlist for offline listening without saving the whole channel. Use the download action beside a song, or **Save offline** in a playlist. Selected audio is stored under ignored `local-data/offline/`, with a configurable cap of 128 MB, 512 MB (default), 1 GB, or 2 GB from the Tracks page. The bridge reports download progress, serves pinned songs by byte range even when Telegram is unavailable, and removes downloaded audio when you unpin it or sign out. The 32 MiB RAM streaming cache is separate from these optional offline files.

The playback bar also has a sleep timer (15, 30, or 60 minutes) and speed control (0.75–2×). The Windows player prepares the next queue item to reduce gaps between songs. Crossfade is not available yet. These newer native controls and offline playback have automated/build coverage but still need a full listening check in the running app.

## Import channel metadata without an API ID

Telegram Desktop can [export an individual chat as JSON](https://telegram.org/blog/export-and-more). In the channel, use its menu → **Export chat history**, choose **JSON**, and turn off media downloads. Then run:

```powershell
node scripts/import-desktop-export.mjs "C:\path\to\export\result.json"
```

This creates an ignored `local-data/library.json` containing song titles, artists, file sizes, and original message IDs. It reports how many songs are larger than the hosted Bot API's 20 MB download limit. The export file and generated library are ignored by Git because channel metadata may be private. This is a catalog import; it does not provide playable file URLs.
