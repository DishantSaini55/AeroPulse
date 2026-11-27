import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { LocalEmailAdapter, LocalWebPushAdapter } from './adapters.js';

test('local email and Web Push adapters post only to a loopback collector', async () => {
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body)); response.writeHead(204).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/collector`;
    const payload = { recipient: 'local@example.test', subject: 'Local notification', body: 'No external message', eventId: '00000000-0000-0000-0000-000000000001' };
    await new LocalEmailAdapter(endpoint).deliver(payload);
    await new LocalWebPushAdapter(endpoint).deliver(payload);
    assert.deepEqual(received, [{ channel: 'EMAIL', ...payload }, { channel: 'WEB_PUSH', ...payload }]);
    assert.throws(() => new LocalEmailAdapter('https://example.com/collector'), /loopback/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
