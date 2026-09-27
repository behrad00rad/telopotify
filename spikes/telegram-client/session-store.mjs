import { spawn } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

const PREFIX = 'dpapi:v1:';

function protectWithWindows(mode, value) {
  if (process.platform !== 'win32') {
    throw new Error('Secure Telegram session storage is currently supported on Windows only');
  }
  const operation = mode === 'protect'
    ? '[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($data),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)'
    : '[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($data),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)';
  const output = mode === 'protect'
    ? '[Convert]::ToBase64String($bytes)'
    : '[Text.Encoding]::UTF8.GetString($bytes)';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $data=[Console]::In.ReadToEnd(); $bytes=${operation}; [Console]::Out.Write(${output})`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let result = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { result += chunk; });
    // Never put PowerShell's output in an error: it may contain session data.
    child.stderr.resume();
    child.on('error', () => reject(new Error('Windows session protection is unavailable')));
    child.on('close', code => code === 0 && result
      ? resolve(result) : reject(new Error('Windows session protection failed')));
    child.stdin.on('error', () => {});
    child.stdin.end(value, 'utf8');
  });
}

export async function saveSession(path, session) {
  if (typeof session !== 'string' || !session.trim()) throw new Error('Telegram session is empty');
  const encrypted = await protectWithWindows('protect', session.trim());
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, PREFIX + encrypted, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, path);
  } finally {
    await unlink(tempPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readSession(path) {
  let stored;
  try { stored = (await readFile(path, 'utf8')).trim(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  if (!stored) return '';
  if (stored.startsWith(PREFIX)) {
    return protectWithWindows('unprotect', stored.slice(PREFIX.length));
  }
  // Migrate the development bridge's earlier plaintext format in place.
  await saveSession(path, stored);
  return stored;
}

export async function removeSession(path) {
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
