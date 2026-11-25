import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { createDb } from '../db.js';
import type { AuthProvider } from '../auth.js';

const db = createDb();
let server: Server | undefined;
try {
  const auth: AuthProvider = { login: async () => null, verifyToken: async token => token === 'analytics-test' ? { id: 'test-user', name: 'Test user', email: 'test@example.test', role: 'SUPERVISOR', active: true } : null };
  server = createApp(db, undefined, auth).listen(0);
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1/analytics`;
  const headers = { authorization: 'Bearer analytics-test' };
  assert.equal((await fetch(`${base}/reliability?dataset=recorded&days=30`)).status, 401);
  const recorded = await fetch(`${base}/reliability?dataset=recorded&days=30`, { headers });
  assert.equal(recorded.status, 200);
  const recordedBody = await recorded.json() as { data: { dataset: string; summary: { equipmentAvailabilityPct: number | null }; devices: unknown[] } };
  assert.equal(recordedBody.data.dataset, 'RECORDED');
  assert.equal(recordedBody.data.devices.length, 20);
  const demo = await fetch(`${base}/reliability?dataset=demo&days=90`, { headers });
  assert.equal(demo.status, 200);
  const demoBody = await demo.json() as { data: { dataset: string; summary: { failureEpisodes: number } }; note: string };
  assert.equal(demoBody.data.dataset, 'HISTORICAL_DEMO');
  assert.ok(demoBody.data.summary.failureEpisodes > 0);
  assert.match(demoBody.note, /illustrative/i);
  const telemetry = await fetch(`${base}/telemetry?device=ILS-P&days=7`, { headers });
  assert.equal(telemetry.status, 200);
  const telemetryBody = await telemetry.json() as { device: string; bucket: string; data: unknown[] };
  assert.equal(telemetryBody.device, 'ILS-P');
  assert.equal(telemetryBody.bucket, 'UTC_HOUR');
  assert.ok(Array.isArray(telemetryBody.data));
  assert.equal((await fetch(`${base}/telemetry?device=UNKNOWN&days=7`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/reliability?dataset=demo&days=12`, { headers })).status, 400);
  console.log('Recorded analytics, labelled demo, UTC telemetry buckets and API validation verified');
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await db.$disconnect();
}
