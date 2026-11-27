import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import bcrypt from 'bcrypt';
import { createDb } from '../db.js';
import { NotificationService } from './service.js';
import { recordNotification } from './service.js';
import { createApp } from '../app.js';
import type { AuthProvider } from '../auth.js';

const db = process.env.DATABASE_URL ? createDb() : undefined;
const createdUsers: string[] = [];
const createdEvents: string[] = [];

after(async () => {
  if (!db) return;
  if (createdEvents.length) await db.notificationEvent.deleteMany({ where: { id: { in: createdEvents } } });
  if (createdUsers.length) await db.auditEvent.deleteMany({ where: { actorId: { in: createdUsers } } });
  if (createdUsers.length) await db.user.deleteMany({ where: { id: { in: createdUsers } } });
  await db.$disconnect();
});

test('notification outbox deduplicates concurrent source events and honors recipient preferences', { skip: !db }, async () => {
  const suffix = randomUUID();
  const [admin, supervisor, engineer] = await Promise.all([
    db!.user.create({ data: { email: `notification-admin-${suffix}@example.test`, name: 'Notification Admin', role: 'ADMINISTRATOR', passwordHash: await bcrypt.hash('notification-test', 10) } }),
    db!.user.create({ data: { email: `notification-supervisor-${suffix}@example.test`, name: 'Notification Supervisor', role: 'SUPERVISOR', passwordHash: await bcrypt.hash('notification-test', 10) } }),
    db!.user.create({ data: { email: `notification-engineer-${suffix}@example.test`, name: 'Notification Engineer', role: 'MAINTENANCE_ENGINEER', passwordHash: await bcrypt.hash('notification-test', 10) } }),
  ]);
  createdUsers.push(admin.id, supervisor.id, engineer.id);
  await db!.notificationPreference.create({ data: { userId: supervisor.id, inAppEnabled: false } });
  const sourceKey = `notification-test:${suffix}`;
  const service = new NotificationService(db!);
  await Promise.all([
    service.record({ sourceKey, kind: 'ALARM_RAISED', priority: 'MAJOR', title: 'Test alarm', body: 'A durable test event', userIds: [engineer.id] }),
    service.record({ sourceKey, kind: 'ALARM_RAISED', priority: 'MAJOR', title: 'Test alarm', body: 'A durable test event', userIds: [engineer.id] }),
  ]);
  const event = await db!.notificationEvent.findUniqueOrThrow({ where: { sourceKey }, include: { recipients: { include: { deliveries: true } } } });
  createdEvents.push(event.id);
  assert.ok(event.recipients.length >= 3);
  assert.equal(event.recipients.find(item => item.userId === supervisor.id)?.deliveries[0]?.status, 'DISABLED');
  assert.equal(event.recipients.find(item => item.userId === admin.id)?.deliveries[0]?.status, 'PENDING');
  assert.equal(event.recipients.find(item => item.userId === engineer.id)?.deliveries[0]?.status, 'PENDING');
  await db!.notificationDelivery.updateMany({ where: { recipient: { eventId: event.id }, status: 'PENDING' }, data: { createdAt: new Date('1900-01-01T00:00:00Z') } });
  for (let batch = 0; batch < 3; batch++) await service.dispatchDue();
  const delivered = await db!.notificationRecipient.findMany({ where: { eventId: event.id }, include: { deliveries: true } });
  assert.equal(delivered.find(item => item.userId === admin.id)?.deliveries[0]?.status, 'DELIVERED');
  assert.equal(delivered.find(item => item.userId === engineer.id)?.deliveries[0]?.status, 'DELIVERED');
});

test('outbox writes roll back with source transaction and delivery failures are bounded', { skip: !db }, async () => {
  const sourceKey = `notification-rollback:${randomUUID()}`;
  await assert.rejects(db!.$transaction(async tx => {
    await recordNotification(tx, { sourceKey, kind: 'INCIDENT_CHANGED', priority: 'WARNING', title: 'Rollback probe', body: 'Must not persist' });
    throw new Error('INJECTED_ROLLBACK');
  }), /INJECTED_ROLLBACK/);
  assert.equal(await db!.notificationEvent.count({ where: { sourceKey } }), 0);
  const createdKey = `notification-retry:${randomUUID()}`;
  await new NotificationService(db!).record({ sourceKey: createdKey, kind: 'INCIDENT_CHANGED', priority: 'WARNING', title: 'Retry probe', body: 'Local only' });
  const event = await db!.notificationEvent.findUniqueOrThrow({ where: { sourceKey: createdKey }, include: { recipients: { include: { deliveries: true }, take: 1 } } });
  createdEvents.push(event.id);
  const delivery = event.recipients[0]?.deliveries[0];
  assert.ok(delivery);
  await db!.notificationDelivery.update({ where: { id: delivery.id }, data: { createdAt: new Date('1800-01-01T00:00:00Z'), nextAttemptAt: new Date(0) } });
  const service = new NotificationService(db!);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await service.dispatchDue(1, () => { throw new Error('INJECTED_DELIVERY_FAILURE'); });
    const state: { attemptCount: number; status: string; lastError: string | null } = await db!.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    assert.equal(state.attemptCount, attempt);
    assert.equal(state.status, attempt === 5 ? 'FAILED' : 'PENDING');
    assert.match(state.lastError ?? '', /INJECTED_DELIVERY_FAILURE/);
    if (attempt < 5) await db!.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
  }
});

test('mounted inbox enforces per-user read and preference isolation', { skip: !db }, async () => {
  const suffix = randomUUID();
  const users = await Promise.all(['a', 'b'].map(label => db!.user.create({ data: { email: `inbox-${label}-${suffix}@example.test`, name: `Inbox ${label}`, role: 'MAINTENANCE_ENGINEER', passwordHash: 'local-test-hash' } })));
  createdUsers.push(...users.map(user => user.id));
  const sourceKey = `notification-inbox:${suffix}`;
  await new NotificationService(db!).record({ sourceKey, kind: 'MAINTENANCE_ASSIGNED', priority: 'WARNING', title: 'Assigned work', body: 'Inspect simulated device', userIds: [users[0]!.id] });
  const event = await db!.notificationEvent.findUniqueOrThrow({ where: { sourceKey }, include: { recipients: true } });
  createdEvents.push(event.id);
  const own = event.recipients.find(row => row.userId === users[0]!.id)!;
  const auth: AuthProvider = { login: async () => null, verifyToken: async token => {
    const user = users.find(item => item.id === token);
    return user ? { id: user.id, email: user.email, name: user.name, role: user.role, active: user.active } : null;
  } };
  const server = createApp(db, undefined, auth).listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    const get = (path: string, userId: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${userId}` } });
    assert.equal((await fetch(`${base}/notifications`)).status, 401);
    const first = await (await get('/notifications?unread=true', users[0]!.id)).json() as { data: { id: string }[] };
    assert.ok(first.data.some(item => item.id === own.id));
    const second = await (await get('/notifications', users[1]!.id)).json() as { data: { id: string }[] };
    assert.ok(!second.data.some(item => item.id === own.id));
    const foreignRead = await fetch(`${base}/notifications/${own.id}/read`, { method: 'POST', headers: { authorization: `Bearer ${users[1]!.id}` } });
    assert.equal(foreignRead.status, 404);
    assert.equal((await db!.notificationRecipient.findUniqueOrThrow({ where: { id: own.id } })).readAt, null);
    const ownRead = await fetch(`${base}/notifications/${own.id}/read`, { method: 'POST', headers: { authorization: `Bearer ${users[0]!.id}` } });
    assert.equal(ownRead.status, 200);
    assert.ok((await db!.notificationRecipient.findUniqueOrThrow({ where: { id: own.id } })).readAt);
    const pref = await fetch(`${base}/notification-preferences`, { method: 'PATCH', headers: { authorization: `Bearer ${users[0]!.id}`, 'content-type': 'application/json' }, body: JSON.stringify({ inAppEnabled: false }) });
    assert.equal(pref.status, 200);
    assert.equal((await (await get('/notification-preferences', users[1]!.id)).json() as { data: { inAppEnabled: boolean } }).data.inAppEnabled, true);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
