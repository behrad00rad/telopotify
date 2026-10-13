import {isIP} from 'node:net';

function ip(value) {
  const address = String(value || '').trim().toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return isIP(address) ? address : null;
}

export function trustedProxyAddresses(value = '') {
  const addresses = value ? String(value).split(',').map(item => ip(item)) : [];
  if (addresses.some(item => !item)) throw new Error('TELOPOTIFY_TRUSTED_PROXIES must contain exact IP addresses separated by commas');
  return new Set(addresses);
}

export function clientAddress(request, trusted = new Set()) {
  const peer = ip(request.socket.remoteAddress) || 'unknown';
  if (!trusted.has(peer)) return peer;
  const header = request.headers['x-forwarded-for'];
  if (typeof header !== 'string' || header.length > 2048) return peer;
  const chain = header.split(',').map(item => ip(item));
  if (!chain.length || chain.some(item => !item)) return peer;
  // Walk from the server outwards. An untrusted hop cannot vouch for entries to its left.
  let address = peer;
  for (let index = chain.length - 1; index >= 0 && trusted.has(address); index--) address = chain[index];
  return address;
}

export class AttemptLimiter {
  constructor({limit = 12, windowMs = 15 * 60_000, maxEntries = 10_000, now = Date.now} = {}) {
    this.limit = limit; this.windowMs = windowMs; this.maxEntries = maxEntries; this.now = now;
    this.entries = new Map();
  }
  take(key) {
    const now = this.now();
    for (const [name, entry] of this.entries) if (entry.expires <= now) this.entries.delete(name);
    const entry = this.entries.get(key);
    if (entry?.count >= this.limit) return Math.max(1, Math.ceil((entry.expires - now) / 1000));
    if (!entry && this.entries.size >= this.maxEntries) return Math.ceil(this.windowMs / 1000);
    // Reserve the attempt before any async password work, including successful requests.
    this.entries.set(key, {count: (entry?.count || 0) + 1, expires: entry?.expires || now + this.windowMs});
    return 0;
  }
}
