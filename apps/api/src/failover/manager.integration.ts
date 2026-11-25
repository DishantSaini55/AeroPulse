import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db.js';
import { RedundancyManager } from './manager.js';

const db = createDb();
const suffix = randomUUID().slice(0, 8).toUpperCase();
const code = `CHECK-${suffix}`;
const policy = { expectedIntervalMs: 5000, missedHeartbeatLimit: 3, timeoutMs: 15000 };
let systemId: string | undefined;
let userId: string | undefined;
try {
  const system = await db.logicalSystem.create({ data: { code, name: `Failover test ${suffix}` } });
  systemId = system.id;
  const primary = await db.device.create({ data: { systemId, code: `${code}-P`, name: 'Test primary', role: 'PRIMARY', activationState: 'ACTIVE' } });
  const secondary = await db.device.create({ data: { systemId, code: `${code}-S`, name: 'Test standby', role: 'SECONDARY', activationState: 'STANDBY' } });
  const now = new Date();
  await db.heartbeat.createMany({ data: [
    { deviceId: primary.id, recordedAt: new Date(now.getTime() - 20000) },
    { deviceId: secondary.id, recordedAt: now },
  ] });
  const manager = new RedundancyManager(db, policy);
  await manager.check(now, systemId);
  assert.equal((await db.device.findUniqueOrThrow({ where: { id: secondary.id } })).activationState, 'ACTIVE');
  assert.equal((await db.device.findUniqueOrThrow({ where: { id: primary.id } })).health, 'UNAVAILABLE');
  assert.equal((await db.failoverEvent.count({ where: { systemId } })), 1);
  await assert.rejects(db.device.update({ where: { id: primary.id }, data: { activationState: 'ACTIVE' } }));
  await manager.check(new Date(now.getTime() + 1000), systemId);
  assert.equal((await db.failoverEvent.count({ where: { systemId } })), 1);
  await db.heartbeat.create({ data: { deviceId: primary.id, recordedAt: new Date(now.getTime() + 2000) } });
  await manager.check(new Date(now.getTime() + 3000), systemId);
  const user = await db.user.create({ data: { email: `${suffix.toLowerCase()}@example.test`, name: 'Integration tester', passwordHash: 'test-only', role: 'SUPERVISOR' } });
  userId = user.id;
  await manager.failback(code, userId, new Date(now.getTime() + 4000));
  assert.equal((await db.device.findUniqueOrThrow({ where: { id: primary.id } })).activationState, 'ACTIVE');
  assert.equal((await db.device.findUniqueOrThrow({ where: { id: secondary.id } })).activationState, 'STANDBY');
  assert.equal((await db.failoverEvent.count({ where: { systemId } })), 2);
  console.log('Database failover, unique-active constraint, idempotence and failback verified.');
} finally {
  if (systemId) {
    await db.failoverEvent.deleteMany({ where: { systemId } });
    await db.heartbeat.deleteMany({ where: { device: { systemId } } });
    await db.telemetryReading.deleteMany({ where: { device: { systemId } } });
    await db.device.deleteMany({ where: { systemId } });
    await db.logicalSystem.delete({ where: { id: systemId } });
  }
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
}
