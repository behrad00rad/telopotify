import {connect} from 'cloudflare:sockets';

// This relay is deliberately limited to Telegram DC addresses and port 443.
function allowedAddress(host) {
  if (!host) return false;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (octets[0] === 149 && octets[1] === 154 && octets[2] >= 160 && octets[2] <= 175) ||
    (octets[0] === 91 && octets[1] === 108);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/telegram' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found', {status: 404});
    }
    const host = url.searchParams.get('host');
    const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim());
    if (!env.RELAY_TOKEN || !protocols.includes(env.RELAY_TOKEN) || !allowedAddress(host)) {
      return new Response('Forbidden', {status: 403});
    }

    let socket;
    try {
      socket = connect({hostname: host, port: 443});
      await socket.opened;
    } catch {
      socket?.close();
      return new Response('Telegram connection failed', {status: 502});
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      try { server.close(); } catch {}
      try { socket.close(); } catch {}
    }
    let writes = Promise.resolve();
    server.addEventListener('message', event => {
      const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) :
        ArrayBuffer.isView(event.data) ? new Uint8Array(event.data.buffer,
          event.data.byteOffset, event.data.byteLength) : null;
      if (!bytes) { close(); return; }
      writes = writes.then(() => writer.write(bytes)).catch(close);
    });
    server.addEventListener('close', close);
    server.addEventListener('error', close);
    (async () => {
      try {
        while (!closed) {
          const {value, done} = await reader.read();
          if (done) break;
          server.send(value);
        }
      } catch {} finally { close(); }
    })();
    return new Response(null, {status: 101, webSocket: client,
      headers: {'Sec-WebSocket-Protocol': env.RELAY_TOKEN}});
  },
};
