import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createApp } from './app.js';
import { createDb } from './db.js';
import { attachRealtime, type TelemetryBatchEvent } from './realtime.js';
import { TelemetrySimulator } from './simulator/service.js';
import type { AuthProvider } from './auth.js';

const auth: AuthProvider = {
  login: async () => null,
  verifyToken: async token => token === 'test-token' ? { id: 'test-user', email: 'test@example.com', name: 'Test Admin', role: 'ADMINISTRATOR', active: true } : null,
};

test('committed telemetry tick reaches a connected Socket.IO client', { skip: !process.env.DATABASE_URL }, async () => {
  const db = createDb();
  const http = createServer(createApp(db, undefined, auth));
  const realtime = attachRealtime(http, auth);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const client = connect(`http://127.0.0.1:${address.port}`, { autoConnect: false, transports: ['websocket'], auth: { token: 'test-token' } });
  try {
    const denied = connect(`http://127.0.0.1:${address.port}`, { autoConnect: false, transports: ['websocket'] });
    try {
      const rejection = new Promise<Error>(resolve => denied.once('connect_error', resolve));
      denied.connect();
      assert.equal((await rejection).message, 'Unauthorized');
    } finally {
      denied.disconnect();
    }
    const connected = new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    client.connect();
    await connected;
    const received = new Promise<TelemetryBatchEvent>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for telemetry event')), 5000);
      client.once('telemetry:batch', (event: TelemetryBatchEvent) => {
        clearTimeout(timeout);
        resolve(event);
      });
    });
    const simulator = new TelemetrySimulator(db, 5000, event => realtime.emit('telemetry:batch', event));
    const at = new Date();
    await simulator.tick(at);
    const event = await received;
    assert.equal(event.recordedAt, at.toISOString());
    assert.equal(event.simulated, true);
    assert.equal(event.deviceCodes.length, 20);
    assert.ok(await db.telemetryReading.count({ where: { recordedAt: at } }) >= 20);
  } finally {
    client.disconnect();
    await new Promise<void>(resolve => realtime.close(() => resolve()));
    await db.$disconnect();
  }
});
