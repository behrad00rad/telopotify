import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const scrypt = promisify(scryptCallback);
const usernamePattern = /^[a-z0-9_]{3,32}$/;
const nameOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const recoveryDigest = value => createHash('sha256').update(
  typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '').digest();
const identity = account => ({id: account.id, username: account.username,
  sessionVersion: account.sessionVersion || 0});

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('Password must be 12–256 characters');
  }
}
async function passwordMatches(account, password) {
  const value = typeof password === 'string' && password.length <= 256 ? password : '';
  const candidate = await scrypt(value, Buffer.from(account?.salt || '0'.repeat(32), 'hex'), 64);
  const expected = Buffer.from(account?.digest || '0'.repeat(128), 'hex');
  return Boolean(account) && expected.length === candidate.length && timingSafeEqual(candidate, expected);
}
async function passwordFields(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  return {salt, digest: (await scrypt(password, Buffer.from(salt, 'hex'), 64)).toString('hex')};
}
function newRecovery() {
  // 192 random bits; only the SHA-256 digest is persisted, never the code.
  const recoveryCode = randomBytes(24).toString('hex').toUpperCase().match(/.{8}/g).join('-');
  return {recoveryCode, recoveryHash: recoveryDigest(recoveryCode).toString('hex')};
}

export class AccountStore {
  constructor(path) { this.path = path; this.accounts = []; this.writeTail = Promise.resolve(); }
  async load() {
    try { this.accounts = JSON.parse(await readFile(this.path, 'utf8')).accounts || []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async register(username, password) {
    const name = nameOf(username);
    if (!usernamePattern.test(name)) throw new Error('Username must be 3–32 letters, numbers, or underscores');
    validatePassword(password);
    return this.queue(async () => {
      if (this.accounts.some(account => account.username === name)) throw new Error('Username already exists');
      const {recoveryCode, recoveryHash} = newRecovery();
      const account = {id: randomBytes(16).toString('hex'), username: name,
        ...await passwordFields(password), recoveryHash, sessionVersion: 0};
      await this.persist([...this.accounts, account]);
      return {...identity(account), recoveryCode};
    });
  }
  async verify(username, password) {
    const account = this.accounts.find(item => item.username === nameOf(username));
    return await passwordMatches(account, password) ? identity(account) : null;
  }
  sessionVersion(id) {
    const account = this.accounts.find(item => item.id === id);
    return account ? account.sessionVersion || 0 : null;
  }
  async changePassword(id, currentPassword, newPassword) {
    validatePassword(newPassword);
    return this.queue(async () => {
      const account = this.accounts.find(item => item.id === id);
      if (!await passwordMatches(account, currentPassword)) return null;
      const updated = {...account, ...await passwordFields(newPassword),
        sessionVersion: (account.sessionVersion || 0) + 1};
      await this.persist(this.accounts.map(item => item.id === id ? updated : item));
      return identity(updated);
    });
  }
  async replaceRecovery(id, password) {
    return this.queue(async () => {
      const account = this.accounts.find(item => item.id === id);
      if (!await passwordMatches(account, password)) return null;
      const {recoveryCode, recoveryHash} = newRecovery();
      await this.persist(this.accounts.map(item => item.id === id ? {...item, recoveryHash} : item));
      return {recoveryCode};
    });
  }
  async recover(username, code, newPassword) {
    validatePassword(newPassword);
    return this.queue(async () => {
      const account = this.accounts.find(item => item.username === nameOf(username));
      const expected = Buffer.from(account?.recoveryHash || '0'.repeat(64), 'hex');
      const provided = recoveryDigest(code);
      const matches = expected.length === provided.length && timingSafeEqual(provided, expected);
      if (!account?.recoveryHash || !matches) return null;
      const {recoveryCode, recoveryHash} = newRecovery();
      const updated = {...account, ...await passwordFields(newPassword), recoveryHash,
        sessionVersion: (account.sessionVersion || 0) + 1};
      await this.persist(this.accounts.map(item => item.id === account.id ? updated : item));
      return {...identity(updated), recoveryCode};
    });
  }
  queue(work) {
    const result = this.writeTail.then(work);
    this.writeTail = result.catch(() => {});
    return result;
  }
  async persist(accounts) {
    await mkdir(dirname(this.path), {recursive: true});
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({accounts}), {mode: 0o600});
    await rename(temporary, this.path);
    this.accounts = accounts;
  }
}
