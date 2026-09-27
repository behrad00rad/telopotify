const REVOKED_SESSION = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_INVALID|USER_DEACTIVATED/;

export function shouldRetryRestore(error) {
  return !REVOKED_SESSION.test(String(error?.message ?? error));
}

export function restoreDelay(attempt) {
  return Math.min(60_000, 5000 * 2 ** Math.min(Math.max(0, attempt), 4));
}
