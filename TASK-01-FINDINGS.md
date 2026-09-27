# Task 01: streaming feasibility

Status: **desktop streaming validated** (2026-09-27). The React Native Windows app played a real Telegram song through its native MediaPlayer and advanced to a distant seek position. iPhone validation is deferred at the user's request.

The user authorized Telegram's published test credentials for local development. A pinned Teleproto client was installed, and the user reports that `spikes/telegram-client/probe.mjs` works with a real song. A saved local session is present. `spikes/telegram-client/library-server.mjs` provides a loopback-only, token-protected catalog and range-streaming bridge for development. It indexed 1,120 songs from an accessible music channel without downloading audio. A 64 KB mid-file range returned HTTP 206, and the app's native player reported `playing` while its position advanced. Clicking the seek bar moved playback from about 1:42 to 3:26 of a 4:26 song. Earlier Telegram data-center connection refusals showed the need for error recovery; the bridge buffers each bounded chunk, retries transient errors, and returns HTTP 502 rather than a partial response. It persists metadata locally for offline browsing on later runs.

## Findings and technical direction

1. Use [TDLib](https://github.com/tdlib/td) as the leading Telegram client candidate. It supports Windows and iOS and has a Boost Software License. Its [`downloadFile`](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1download_file.html) accepts an offset and byte limit, allowing a selected region of a file to be fetched. `readFilePart` can expose cached bytes when direct file access is unavailable. This supports the desired on-demand behavior at the API level. It does **not** yet prove that playback will start quickly or that requests can continue under iOS background execution.
2. Avoid basing the app on GramJS without another review: [its repository was archived in July 2026](https://github.com/gram-js/gramjs). Its successor, Teleproto, may be useful for a Node-only experiment, but TDLib has the clearer cross-platform story.
3. The generated Windows app uses React Native 0.84.1 and React Native Windows 0.84.0, matching the latter package's exact peer dependency. Its native Debug x64 solution builds and the packaged app deploys and launches. [React Native Windows 0.84 requires Visual Studio 2026](https://github.com/microsoft/react-native-windows/releases); Visual Studio 2026, .NET 10, and Windows SDK 10.0.26100 are installed. The RNW default is SDK 10.0.22621, so this machine builds with an explicit 10.0.26100 override. The user approved the persistent `AllowAllTrustedApps` setting needed for deployment.
4. Use a platform playback adapter. [Expo Audio lists iOS, Android, tvOS, and Web, but not Windows](https://docs.expo.dev/versions/latest/sdk/audio/). React Native Track Player provides iOS background playback, but its current major version has [commercial licensing terms](https://github.com/doublesymmetry/react-native-track-player) and Windows support has not been validated for that version. A Windows native media implementation may be required.
5. iPhone background playback requires an iOS playback audio session and the `audio` background mode; lock-screen metadata and controls use Apple's Now Playing APIs. See [AVAudioSession](https://developer.apple.com/documentation/avfaudio/avaudiosession) and [MPNowPlayingInfoCenter](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter). A Mac/Xcode build environment and an iPhone are required for the intended real-device validation.

## Completed experiment

`spikes/range-stream/` is a dependency-free Node experiment. It serves a **local** audio file from loopback with HTTP byte-range support. A browser audio player can request the start of a song and another range after a seek. This proves the range response contract and gives us a test target for later native players. It does not connect to Telegram and does not establish React Native device support.

Run `node --test --test-isolation=none spikes/range-stream/*.test.mjs` from the repository root. The `--test-isolation=none` flag avoids child-process creation restrictions on this development host. To try a local audio file, run `node spikes/range-stream/server.mjs <path-to-audio-file>` and open the printed localhost URL. The file stays local and `.gitignore` excludes common audio formats.

## Next validation steps

- Replace the terminal-based development bridge with an in-app authentication and channel-selection flow. Production credentials are still needed before release. Never put the login code, two-step password, API hash, or session files in an issue, commit, or chat.
- Measure time to first sound and cache growth, then add bounded persistent caching, clear-cache controls, and network-loss recovery.
- Evaluate a production TDLib adapter and licensing after the desktop app's core experience is stable. The current Teleproto bridge is development-only.
- Later, repeat on a physical iPhone, including locked-screen playback long enough to exceed the initial buffer, seek while locked, phone-call interruption, and network loss/recovery.
- Decide on the playback libraries only after the two device tests and a license review.

Task 01's desktop playback-and-seek gate is complete. iPhone proof remains a separate later validation gate.

## Alternative while my.telegram.org/apps returns ERROR

Telegram Desktop can [export channel history as JSON](https://telegram.org/blog/export-and-more) without selecting the media files. Its [export implementation](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/export/output/export_output_json.cpp) includes audio message IDs, titles, performers, filenames, durations, and file sizes even when a media file is skipped. `scripts/import-desktop-export.mjs` turns those records into an ignored local song catalog. This gets the 1,000-song library without downloading 1,000 songs. It does not provide file bytes.

For playback without an application API ID, the [Bot API](https://core.telegram.org/bots/api#forwardmessage) is a candidate if a bot can access the source channel: `forwardMessage` accepts a source channel and message ID and returns a Message with the audio `file_id`. The target would be a private staging chat; forwarding old posts and access rights must be tested on one song before building around it. The hosted [getFile](https://core.telegram.org/bots/api#getfile) method is limited to 20 MB per file, so the catalog import reports how many songs exceed that limit. Direct URL range behavior also needs measurement before claiming seek support. The bot token must stay local and out of Git. This is a conditional fallback, not yet a proven full replacement for TDLib.

For a development-only TDLib experiment, Telegram Desktop's [official source documentation](https://github.com/telegramdesktop/tdesktop/blob/dev/docs/api_credentials.md) provides limited test API credentials. It explicitly warns that deployed apps using them get login errors, so this route can validate the design but cannot ship as the app's permanent credentials.
