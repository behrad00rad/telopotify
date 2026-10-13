# Web beta and source review — 2026-10-13

Telopotify remains MIT-licensed. The hosted account service is an **invite-only
development beta**, with registration closed unless the owner explicitly enables
it in an access-controlled environment.

## Source and history findings

The review inspected the working copies of 150 tracked files, new non-ignored
source/test files, sensitive file-name patterns, and 302 historical blobs across
all local Git refs. Checks covered private keys, recognizable access-token
formats, credential-bearing URLs, and configured Telegram/application secrets.
Candidate reports contained file names and finding types only, never values.

- No accidentally committed personal credentials, account databases, Telegram
  sessions, or signing keys were identified by these checks.
- Historical versions of `spikes/telegram-client/library-server.mjs`,
  `spikes/telegram-client/probe.mjs`, and
  `TelopotifyApp/ios/TelopotifyApp/TelopotifyTelegram.swift` contain Telegram
  Desktop's publicly documented test API credentials. Current runnable code has
  no embedded fallback. Those historical values were reviewed as known public
  samples, not as leaked personal credentials.
- Git history was not rewritten. No remote deployment, publication, or repository
  visibility changes were made.

Pattern checks are not proof that every possible secret or vulnerability is
absent. This review does not cover remote build artifacts, GitHub account
settings, un-fetched refs, ignored personal data, or a complete dependency audit.

## Account and hosting behavior

Passwords use salted scrypt hashes. Generated recovery codes have 192 random
bits; only their SHA-256 hashes are persisted. Recovery and code replacement are
serialized with account writes. A code is consumed only after its replacement
and new password have been saved successfully. Neither API responses nor logs
echo malformed JSON containing passwords or codes.

Password changes revoke other web sessions and refresh the requesting session.
Recovery revokes all existing web sessions. Persisted credential versions reject
stale sessions and concurrent login results. The account ID, user directory,
Telegram session, library, and playlists remain in place. This is web-account
recovery, not recovery of the user's Telegram credentials.

Login, recovery, and password-confirmation attempts have bounded, expiring
limits with reservations before asynchronous work. Forwarded IPs are accepted
only from explicitly trusted proxy addresses. An untrusted hop cannot supply
the identity of hops to its left. Configure and secure the hosting proxy as
described in the README; rate limits and sessions are in memory and assume one
Node account-server instance.

Telegram processes have a configurable startup-inclusive cap and idle timeout.
An open response, including audio streaming, holds a process lease. Cleanup
does not stop leased processes. Cleanup preserves data and on-demand startup
restores an idle user's service. Capacity errors are retryable and do not evict
active playback.

The beta still requires a trusted operator, HTTPS, protected persistent storage,
backups, and real-device listening checks. The iOS build configuration changes
must be compiled on macOS/Xcode; Windows cannot validate that native build.
