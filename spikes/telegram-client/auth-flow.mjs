function errorCode(error) {
  return String(error?.errorMessage ?? error?.code ?? error?.message ?? '').toUpperCase();
}

function friendlyError(error) {
  const code = errorCode(error);
  if (code.includes('PHONE_CODE_INVALID')) return 'Incorrect code. Try again.';
  if (code.includes('PHONE_CODE_EXPIRED')) return 'Code expired. Start sign-in again.';
  if (code.includes('PASSWORD_HASH_INVALID')) return 'Incorrect two-step password. Try again.';
  if (code.includes('EMAIL_CODE_INVALID')) return 'Incorrect email code. Try again.';
  if (code.includes('EMAIL_CODE_EXPIRED')) return 'Email code expired. Start sign-in again.';
  if (code.includes('PHONE_NUMBER_INVALID')) return 'Check the phone number and try again.';
  if (code.includes('PHONE_NUMBER_BANNED')) return 'Telegram does not allow this phone number to sign in.';
  if (code.includes('FLOOD_WAIT')) {
    const seconds = Number(/FLOOD_WAIT_(\d+)/.exec(code)?.[1]);
    return seconds ? `Telegram asked you to wait ${seconds} seconds before trying again.` :
      'Telegram asked you to wait before trying again.';
  }
  if (code.includes('API_ID_PUBLISHED_FLOOD')) return 'The development Telegram API credentials are rate-limited. Please try later.';
  if (code.includes('API_ID_INVALID') || code.includes('API_ID_PUBLISHED')) return 'The Telegram API credentials are not accepted.';
  if (code.includes('SIGN_UP_DISABLED')) return 'This app only signs in existing Telegram accounts.';
  if (/EPERM|EACCES|SESSION PROTECTION|SESSION STORAGE/.test(code)) {
    return 'Telegram connected, but this server could not save your session. Contact the app owner.';
  }
  if (/CONNECTION|NETWORK|TIMEOUT|ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN/.test(code)) {
    return 'Could not reach Telegram reliably. Check your VPN or connection, then try again.';
  }
  const safeCode = /^[A-Z][A-Z0-9_]{2,79}$/.test(code) ? ` (${code})` : '';
  return `Telegram sign-in failed${safeCode}. Try again or contact the app owner.`;
}

export function createAuthFlow(client, onAuthorized) {
  let step = 'phone';
  let error = '';
  let diagnostic = '';
  let pending = null;
  let running = false;
  let cancelled = false;

  function prompt(kind) {
    if (cancelled) throw new Error('Sign-in cancelled');
    step = kind;
    return new Promise((resolve, reject) => { pending = { kind, resolve, reject }; });
  }

  function state() { return { step, error, diagnostic }; }

  function begin(phone) {
    if (running) throw new Error('Sign-in is already in progress');
    if (!/^\+?[1-9]\d{6,14}$/.test(phone)) throw new Error('Enter a phone number in international format');
    running = true;
    cancelled = false;
    error = '';
    diagnostic = '';
    step = 'connecting';
    const work = client.start({
      phoneNumber: () => phone,
      phoneCode: () => prompt('code'),
      password: () => prompt('password'),
      emailAddress: () => prompt('email'),
      emailVerification: async () => ({ type: 'code', code: await prompt('emailCode') }),
      firstAndLastNames: async () => { throw new Error('SIGN_UP_DISABLED'); },
      onError: failure => {
        error = friendlyError(failure);
        const code = errorCode(failure);
        diagnostic = /^[A-Z][A-Z0-9_]{2,79}$/.test(code) ? code :
          String(failure?.code || failure?.name || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 80);
        return cancelled || !/PHONE_CODE_INVALID|PASSWORD_HASH_INVALID|EMAIL_CODE_INVALID/.test(code);
      },
    }).then(async () => {
      if (cancelled) return;
      await onAuthorized();
      step = 'authorized';
      error = '';
      diagnostic = '';
    }).catch(failure => {
      if (cancelled) return;
      step = 'phone';
      if (!error) {
        error = friendlyError(failure);
        diagnostic = String(failure?.code || failure?.name || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 80);
      }
    }).finally(() => { running = false; });
    return work;
  }

  function submit(kind, value) {
    if (!pending || pending.kind !== kind) throw new Error('That sign-in step is not active');
    if (typeof value !== 'string' || !value.trim() || value.length > 256) {
      throw new Error('Enter the requested value');
    }
    const current = pending;
    pending = null;
    error = '';
    diagnostic = '';
    step = 'checking';
    current.resolve(value.trim());
  }

  function cancel() {
    cancelled = true;
    if (pending) {
      pending.reject(new Error('Sign-in cancelled'));
      pending = null;
    }
    step = 'phone';
    error = '';
    diagnostic = '';
  }

  return { state, begin, submit, cancel };
}
