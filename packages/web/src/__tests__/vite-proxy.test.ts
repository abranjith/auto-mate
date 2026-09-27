import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import config from '../../vite.config';

let vite: ViteDevServer | undefined;
let upstream: ReturnType<typeof createHttpServer> | undefined;
afterEach(async () => {
  await vite?.close();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()) ?? resolve());
  vite = undefined;
  upstream = undefined;
});

it('keeps the guarded dev port and forwards WebSocket upgrades to the API', async () => {
  expect(config.server?.strictPort).toBe(true);
  const target = config.server?.proxy?.['/api'];
  expect(target).toMatchObject({ ws: true, changeOrigin: true });
  if (!target || typeof target === 'string') throw new Error('API proxy must have upgrade options');
  upstream = createHttpServer();
  let upgradedPath = '';
  upstream.on('upgrade', (request, socket) => {
    upgradedPath = request.url ?? '';
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  upstream.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => upstream!.once('listening', resolve));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('upstream did not listen');
  vite = await createServer({ configFile: false, plugins: [], server: { host: '127.0.0.1', port: 0, strictPort: config.server?.strictPort, proxy: { '/api': { ...target, target: `http://127.0.0.1:${upstreamAddress.port}` } } } });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not listen');
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect(address.port, '127.0.0.1');
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => { resolve(chunk.toString()); socket.destroy(); });
    socket.on('connect', () => socket.write('GET /api/ws/executions/1 HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
  });
  expect(reply).toContain('101 Switching Protocols');
  expect(upgradedPath).toBe('/api/ws/executions/1');
});
