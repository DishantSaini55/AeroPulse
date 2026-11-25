import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { createDb } from './db.js';
import { TelemetrySimulator } from './simulator/service.js';
import type { AuthProvider } from './auth.js';

const auth: AuthProvider = {
  login: async () => null,
  verifyToken: async token => token === 'test-token' ? { id: 'test-user', email: 'test@example.com', name: 'Test Admin', role: 'ADMINISTRATOR', active: true } : null,
};
const headers = { authorization: 'Bearer test-token' };

let server: Server;
let baseUrl: string;

before(async () => {
  server = createApp(undefined, undefined, auth).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('health endpoint returns service status', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'aeropulse-api', instanceId: 'local' });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.ok(response.headers.get('x-request-id'));
});

test('create and retrieve a simulated note', async () => {
  const created = await fetch(`${baseUrl}/api/v1/notes`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ systemName: 'Radar System', message: 'Training observation' }),
  });
  assert.equal(created.status, 201);
  const result = await created.json() as { data: { id: string; message: string } };
  assert.equal(result.data.message, 'Training observation');
  assert.equal(created.headers.get('location'), `/api/v1/notes/${result.data.id}`);
  const found = await fetch(`${baseUrl}/api/v1/notes/${result.data.id}`, { headers });
  assert.equal(found.status, 200);
  assert.deepEqual((await found.json() as { data: unknown }).data, result.data);
});

test('invalid input, unknown note and malformed JSON return JSON errors', async () => {
  const invalid = await fetch(`${baseUrl}/api/v1/notes`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ systemName: '', message: '' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
  const missing = await fetch(`${baseUrl}/api/v1/notes/does-not-exist`, { headers });
  assert.equal(missing.status, 404);
  const malformed = await fetch(`${baseUrl}/api/v1/notes`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { error: { code: string } }).error.code, 'INVALID_JSON');
});

test('database asset registry returns ten systems and twenty devices', { skip: !process.env.DATABASE_URL }, async () => {
  const db = createDb();
  await db.$connect();
  const assetServer = createApp(db, undefined, auth).listen(0);
  try {
    await new Promise<void>((resolve) => assetServer.once('listening', resolve));
    const address = assetServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const url = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${url}/api/v1/systems`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Array<{ code: string; devices: unknown[] }> };
    assert.equal(body.data.length, 10);
    assert.equal(body.data.reduce((sum, system) => sum + system.devices.length, 0), 20);
    const radar = await fetch(`${url}/api/v1/systems/RADAR`, { headers });
    assert.equal(radar.status, 200);
    assert.equal((await radar.json() as { data: { devices: unknown[] } }).data.devices.length, 2);
    assert.equal((await fetch(`${url}/api/v1/systems/UNKNOWN`, { headers })).status, 404);
    const snapshot = await fetch(`${url}/api/v1/monitoring/snapshot`, { headers });
    assert.equal(snapshot.status, 200);
    const monitoring = await snapshot.json() as { data: Array<{ latestTelemetry: unknown; latestHeartbeatAt: string | null }> };
    assert.equal(monitoring.data.length, 20);
  } finally {
    await new Promise<void>((resolve, reject) => assetServer.close((error) => error ? reject(error) : resolve()));
    await db.$disconnect();
  }
});

test('one simulator tick persists 20 readings and heartbeats', { skip: !process.env.DATABASE_URL }, async () => {
  const db = createDb();
  const at = new Date(Date.now() - 86_400_000);
  const beforeReadings = await db.telemetryReading.count({ where: { recordedAt: at } });
  const beforeHeartbeats = await db.heartbeat.count({ where: { recordedAt: at } });
  const simulator = new TelemetrySimulator(db);
  await simulator.tick(at);
  assert.equal(await db.telemetryReading.count({ where: { recordedAt: at } }), beforeReadings + 20);
  assert.equal(await db.heartbeat.count({ where: { recordedAt: at } }), beforeHeartbeats + 20);
  const assetServer = createApp(db, undefined, auth).listen(0);
  try {
    await new Promise<void>((resolve) => assetServer.once('listening', resolve));
    const address = assetServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/devices/RADAR-P/telemetry?limit=1`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Array<{ simulated: boolean; temperatureC: number }>; latestHeartbeatAt: string };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.simulated, true);
    assert.equal(typeof body.data[0]?.temperatureC, 'number');
    assert.ok(body.latestHeartbeatAt);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/v1/devices/RADAR-P/telemetry?limit=0`, { headers })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => assetServer.close((error) => error ? reject(error) : resolve()));
    await db.$disconnect();
  }
});

test('scheduler repeats ticks and stops cleanly', { skip: !process.env.DATABASE_URL }, async () => {
  const db = createDb();
  const events: string[] = [];
  const simulator = new TelemetrySimulator(db, 25, event => events.push(event.recordedAt));
  simulator.start();
  try {
    const deadline = Date.now() + 10000;
    while (events.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(events.length >= 2);
  } finally {
    await simulator.stop();
  }
  const stoppedAt = events.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events.length, stoppedAt);
  await db.$disconnect();
});

test('administrator demo can pause and resume one simulated heartbeat', { skip: !process.env.DATABASE_URL }, async () => {
  const db = createDb();
  const simulator = new TelemetrySimulator(db);
  const at = new Date(Date.now() - 2 * 86_400_000);
  simulator.setHeartbeatPaused('RADAR-P', true);
  assert.equal(simulator.isHeartbeatPaused('RADAR-P'), true);
  await simulator.tick(at);
  assert.equal(await db.heartbeat.count({ where: { device: { code: 'RADAR-P' }, recordedAt: at } }), 0);
  assert.equal(await db.heartbeat.count({ where: { device: { code: 'RADAR-S' }, recordedAt: at } }), 1);
  simulator.setHeartbeatPaused('RADAR-P', false);
  await simulator.tick(new Date(at.getTime() + 5000));
  assert.equal(await db.heartbeat.count({ where: { device: { code: 'RADAR-P' }, recordedAt: new Date(at.getTime() + 5000) } }), 1);
  await db.$disconnect();
});
