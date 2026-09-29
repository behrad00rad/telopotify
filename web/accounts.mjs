import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const scrypt = promisify(scryptCallback);
const usernamePattern = /^[a-z0-9_]{3,32}$/;

export class AccountStore {
  constructor(path) { this.path = path; this.accounts = []; this.writeTail = Promise.resolve(); }
  async load() {
    try { this.accounts = JSON.parse(await readFile(this.path, 'utf8')).accounts || []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async register(username, password) {
    const name = String(username || '').trim().toLowerCase();
    if (!usernamePattern.test(name)) throw new Error('Username must be 3–32 letters, numbers, or underscores');
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new Error('Password must be 12–256 characters');
    }
    return this.queue(async () => {
      if (this.accounts.some(account => account.username === name)) throw new Error('Username already exists');
      const salt = randomBytes(16).toString('hex');
      const digest = (await scrypt(password, Buffer.from(salt, 'hex'), 64)).toString('hex');
      const account = {id: randomBytes(16).toString('hex'), username: name, salt, digest};
      this.accounts.push(account);
      await this.persist();
      return {id: account.id, username: account.username};
    });
  }
  async verify(username, password) {
    const account = this.accounts.find(item => item.username === String(username || '').trim().toLowerCase());
    // Derive even for a missing user so error timing does not directly reveal account names.
    const salt = Buffer.from(account?.salt || '0'.repeat(32), 'hex');
    const candidate = await scrypt(String(password || ''), salt, 64);
    const expected = Buffer.from(account?.digest || '0'.repeat(128), 'hex');
    if (!account || !timingSafeEqual(candidate, expected)) return null;
    return {id: account.id, username: account.username};
  }
  queue(work) {
    const result = this.writeTail.then(work);
    this.writeTail = result.catch(() => {});
    return result;
  }
  async persist() {
    await mkdir(dirname(this.path), {recursive: true});
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({accounts: this.accounts}), {mode: 0o600});
    await rename(temporary, this.path);
  }
}
