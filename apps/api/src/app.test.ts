import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from './app.js';

let server: Server;
let baseUrl: string;

before(async () => {
  server = createApp().listen(0);
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
  assert.deepEqual(await response.json(), { status: 'ok', service: 'aeropulse-api' });
});

test('create and retrieve a simulated note', async () => {
  const created = await fetch(`${baseUrl}/api/v1/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ systemName: 'Radar System', message: 'Training observation' }),
  });
  assert.equal(created.status, 201);
  const result = await created.json() as { data: { id: string; message: string } };
  assert.equal(result.data.message, 'Training observation');
  assert.equal(created.headers.get('location'), `/api/v1/notes/${result.data.id}`);
  const found = await fetch(`${baseUrl}/api/v1/notes/${result.data.id}`);
  assert.equal(found.status, 200);
  assert.deepEqual((await found.json() as { data: unknown }).data, result.data);
});

test('invalid input, unknown note and malformed JSON return JSON errors', async () => {
  const invalid = await fetch(`${baseUrl}/api/v1/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemName: '', message: '' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
  const missing = await fetch(`${baseUrl}/api/v1/notes/does-not-exist`);
  assert.equal(missing.status, 404);
  const malformed = await fetch(`${baseUrl}/api/v1/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { error: { code: string } }).error.code, 'INVALID_JSON');
});
