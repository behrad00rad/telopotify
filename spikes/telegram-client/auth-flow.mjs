function friendlyError(error) {
  const code = String(error?.errorMessage ?? error?.message ?? '');
  if (code.includes('PHONE_CODE_INVALID')) return 'Incorrect code. Try again.';
  if (code.includes('PHONE_CODE_EXPIRED')) return 'Code expired. Start sign-in again.';
  if (code.includes('PASSWORD_HASH_INVALID')) return 'Incorrect two-step password. Try again.';
  if (code.includes('PHONE_NUMBER_INVALID')) return 'Check the phone number and try again.';
  if (code.includes('FLOOD_WAIT')) return 'Telegram asked you to wait before trying again.';
  if (code.includes('SIGN_UP_DISABLED')) return 'This app only signs in existing Telegram accounts.';
  return 'Telegram sign-in failed. Try again.';
}

export function createAuthFlow(client, onAuthorized) {
  let step = 'phone';
  let error = '';
  let pending = null;
  let running = false;
  let cancelled = false;

  function prompt(kind) {
    if (cancelled) throw new Error('Sign-in cancelled');
    step = kind;
    return new Promise((resolve, reject) => { pending = { kind, resolve, reject }; });
  }

  function state() { return { step, error }; }

  function begin(phone) {
    if (running) throw new Error('Sign-in is already in progress');
    if (!/^\+?[1-9]\d{6,14}$/.test(phone)) throw new Error('Enter a phone number in international format');
    running = true;
    cancelled = false;
    error = '';
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
        const code = String(failure?.errorMessage ?? failure?.message ?? '');
        return cancelled || !/PHONE_CODE_INVALID|PASSWORD_HASH_INVALID|EMAIL_CODE_INVALID/.test(code);
      },
    }).then(async () => {
      if (cancelled) return;
      await onAuthorized();
      step = 'authorized';
      error = '';
    }).catch(failure => {
      if (cancelled) return;
      step = 'phone';
      if (!error) error = friendlyError(failure);
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
  }

  return { state, begin, submit, cancel };
}
