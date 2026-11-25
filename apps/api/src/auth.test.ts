import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import bcrypt from 'bcrypt';
import { SignJWT } from 'jose';
import { createApp } from './app.js';
import { AuthService } from './auth.js';
import { createDb } from './db.js';

const secret = 'test-only-secret-that-is-more-than-32-bytes-long';
const password = 'TestPassword-Strong-123!';

test('JWT login, backend roles and disabled-user revocation', { skip: !process.env.DATABASE_URL }, async () => {
  const db = createDb();
  const suffix = randomUUID();
  const admin = await db.user.create({ data: { email: `admin-${suffix}@example.test`, name: 'Test Admin', role: 'ADMINISTRATOR', passwordHash: await bcrypt.hash(password, 10) } });
  const engineer = await db.user.create({ data: { email: `engineer-${suffix}@example.test`, name: 'Test Engineer', role: 'MAINTENANCE_ENGINEER', passwordHash: await bcrypt.hash(password, 10) } });
  const createdIds = [admin.id, engineer.id];
  const auth = new AuthService(db, secret);
  const server = createApp(db, undefined, auth).listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${url}/api/v1/health`)).status, 200);
    assert.equal((await fetch(`${url}/api/v1/systems`)).status, 401);
    const login = async (email: string, candidate: string) => fetch(`${url}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: candidate }),
    });
    assert.equal((await login(admin.email, 'incorrect-password')).status, 401);
    const adminResponse = await login(admin.email.toUpperCase(), password);
    assert.equal(adminResponse.status, 200);
    const adminResult = await adminResponse.json() as { token: string; user: { id: string; passwordHash?: string } };
    assert.equal(adminResult.user.id, admin.id);
    assert.equal(adminResult.user.passwordHash, undefined);
    const adminHeaders = { authorization: `Bearer ${adminResult.token}` };
    assert.equal((await fetch(`${url}/api/v1/auth/me`, { headers: adminHeaders })).status, 200);
    assert.equal((await fetch(`${url}/api/v1/systems`, { headers: adminHeaders })).status, 200);
    const engineerResult = await (await login(engineer.email, password)).json() as { token: string };
    const engineerHeaders = { authorization: `Bearer ${engineerResult.token}` };
    assert.equal((await fetch(`${url}/api/v1/systems`, { headers: engineerHeaders })).status, 200);
    assert.equal((await fetch(`${url}/api/v1/users`, { headers: engineerHeaders })).status, 403);
    assert.equal((await fetch(`${url}/api/v1/users`, { headers: adminHeaders })).status, 200);
    const created = await fetch(`${url}/api/v1/users`, {
      method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `supervisor-${suffix}@example.test`, name: 'Test Supervisor', role: 'SUPERVISOR', password }),
    });
    assert.equal(created.status, 201);
    const supervisor = await created.json() as { data: { id: string; passwordHash?: string } };
    createdIds.push(supervisor.data.id);
    assert.equal(supervisor.data.passwordHash, undefined);
    assert.equal((await fetch(`${url}/api/v1/users`, {
      method: 'POST', headers: { ...engineerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `blocked-${suffix}@example.test`, name: 'Blocked', role: 'ADMINISTRATOR', password }),
    })).status, 403);
    assert.equal((await fetch(`${url}/api/v1/users/${admin.id}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ active: false }),
    })).status, 409);
    const disable = await fetch(`${url}/api/v1/users/${engineer.id}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ active: false }),
    });
    assert.equal(disable.status, 200);
    assert.equal((await fetch(`${url}/api/v1/systems`, { headers: engineerHeaders })).status, 401);
    const expired = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(admin.id)
      .setIssuer('aeropulse').setAudience('aeropulse-web').setIssuedAt().setExpirationTime('-1h')
      .sign(new TextEncoder().encode(secret));
    assert.equal(await auth.verifyToken(expired), null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.user.deleteMany({ where: { id: { in: createdIds } } });
    await db.$disconnect();
  }
});
