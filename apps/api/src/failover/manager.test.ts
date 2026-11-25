import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '../db.js';
import { RedundancyManager, FailbackError } from './manager.js';

const at = new Date('2026-01-01T12:00:00.000Z');
const policy = { expectedIntervalMs: 5000, missedHeartbeatLimit: 3, timeoutMs: 15000 };

function fixture(standbyFresh = true) {
  const devices = [
    { id: 'a', code: 'DEMO-P', role: 'PRIMARY', health: 'HEALTHY', activationState: 'ACTIVE', createdAt: new Date(at.getTime() - 60000), heartbeats: [{ recordedAt: new Date(at.getTime() - 20000) }] },
    { id: 'b', code: 'DEMO-S', role: 'SECONDARY', health: 'HEALTHY', activationState: 'STANDBY', createdAt: new Date(at.getTime() - 60000), heartbeats: [{ recordedAt: new Date(at.getTime() - (standbyFresh ? 5000 : 20000)) }] },
  ];
  const system = { id: 's', code: 'DEMO', availability: 'AVAILABLE', devices };
  const events: { action: string; result: string; toDeviceId?: string | null }[] = [];
  const db = {
    logicalSystem: {
      findMany: async () => [system],
      findUniqueOrThrow: async () => system,
      findUnique: async () => ({ id: system.id }),
      update: async ({ data }: { data: { availability: string } }) => Object.assign(system, data),
    },
    device: { update: async ({ where, data }: { where: { id: string }; data: { health?: string; activationState?: string } }) => {
      Object.assign(devices.find(item => item.id === where.id)!, data);
    } },
    failoverEvent: { create: async ({ data }: { data: { action: string; result: string; toDeviceId?: string | null } }) => { events.push(data); return data; } },
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as Database;
  return { db, devices, system, events };
}

test('automatic failover activates healthy standby once and records result', async () => {
  const { db, devices, system, events } = fixture();
  const manager = new RedundancyManager(db, policy);
  const change = await manager.check(at);
  assert.deepEqual(change?.systemCodes, ['DEMO']);
  assert.equal(devices[0]!.health, 'UNAVAILABLE');
  assert.equal(devices[0]!.activationState, 'INELIGIBLE');
  assert.equal(devices[1]!.activationState, 'ACTIVE');
  assert.equal(system.availability, 'AVAILABLE');
  assert.equal(events[0]?.result, 'SUCCESS');
  assert.equal(events[0]?.toDeviceId, 'b');
  assert.equal(await manager.check(new Date(at.getTime() + 1000)), null);
  assert.equal(events.length, 1);
});

test('no healthy standby records failed attempt and service outage', async () => {
  const { db, system, events } = fixture(false);
  await new RedundancyManager(db, policy).check(at);
  assert.equal(system.availability, 'OUTAGE');
  assert.equal(events[0]?.result, 'NO_HEALTHY_STANDBY');
  assert.equal(events[0]?.toDeviceId, undefined);
});

test('manual failback requires recovered primary and restores assignment', async () => {
  const { db, devices, system, events } = fixture();
  const manager = new RedundancyManager(db, policy);
  await manager.check(at);
  await assert.rejects(manager.failback('DEMO', 'user', at), (error: unknown) => error instanceof FailbackError && error.code === 'PRIMARY_NOT_READY');
  devices[0]!.heartbeats[0]!.recordedAt = new Date(at.getTime() + 1000);
  await manager.check(new Date(at.getTime() + 2000));
  const event = await manager.failback('DEMO', 'user', new Date(at.getTime() + 3000));
  assert.equal(event.action, 'MANUAL_FAILBACK');
  assert.equal(devices[0]!.activationState, 'ACTIVE');
  assert.equal(devices[1]!.activationState, 'STANDBY');
  assert.equal(system.availability, 'AVAILABLE');
  assert.equal(events.length, 2);
});
