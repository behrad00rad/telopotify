import {createServer} from 'node:net';

export function relayEnabled(value, url) {
  if (value === undefined || value === '') return Boolean(url);
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error('TELOPOTIFY_RELAY_ENABLED must be 1 or 0');
}

function telegramAddress(host) {
  if (!host) return false;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    ((parts[0] === 149 && parts[1] === 154 && parts[2] >= 160 && parts[2] <= 175) ||
      (parts[0] === 91 && parts[1] === 108));
}

export async function startTelegramRelay(url, token) {
  let endpoint;
  try { endpoint = new URL(url); }
  catch { throw new Error('Set TELOPOTIFY_RELAY_URL to the Worker wss:// URL'); }
  if (endpoint.protocol !== 'wss:' || !token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error('Set TELOPOTIFY_RELAY_URL to a wss:// Worker URL and TELOPOTIFY_RELAY_TOKEN to a 32+ character secret');
  }
  const server = createServer(client => {
    let stage = 0;
    let buffer = Buffer.alloc(0);
    let websocket;
    const fail = code => { if (!client.destroyed) client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); };
    client.on('data', data => {
      if (stage === 2) {
        if (websocket?.readyState === WebSocket.OPEN) websocket.send(data);
        else client.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 1024) { client.destroy(); return; }
      if (stage === 0 && buffer.length >= 2) {
        const length = 2 + buffer[1];
        if (buffer.length < length) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, length).includes(0)) { client.destroy(); return; }
        buffer = buffer.subarray(length);
        client.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage !== 1 || buffer.length < 4) return;
      const type = buffer[3];
      const length = type === 1 ? 10 : type === 3 && buffer.length >= 5 ? 7 + buffer[4] : 0;
      if (!length || buffer.length < length) return;
      const host = type === 1 ? [...buffer.subarray(4, 8)].join('.') : buffer.subarray(5, 5 + buffer[4]).toString();
      const port = buffer.readUInt16BE(length - 2);
      if (buffer[0] !== 5 || buffer[1] !== 1 || port !== 443 || !telegramAddress(host)) { fail(2); return; }
      const pending = buffer.subarray(length);
      buffer = Buffer.alloc(0);
      stage = 3;
      client.pause();
      const target = new URL(endpoint);
      target.pathname = '/telegram';
      target.searchParams.set('host', host);
      websocket = new WebSocket(target, [token]);
      websocket.binaryType = 'arraybuffer';
      websocket.addEventListener('open', () => {
        if (client.destroyed) { websocket.close(); return; }
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        stage = 2;
        if (pending.length) websocket.send(pending);
        client.resume();
      });
      websocket.addEventListener('message', event => {
        if (typeof event.data !== 'string' && !client.destroyed) client.write(Buffer.from(event.data));
      });
      websocket.addEventListener('error', () => { if (stage !== 2) fail(1); else client.destroy(); });
      websocket.addEventListener('close', () => client.destroy());
    });
    client.on('error', () => {});
    client.on('close', () => { try { websocket?.close(); } catch {} });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}
