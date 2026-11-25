import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '../db.js';
import { HeartbeatMonitor, heartbeatHealth, serviceAvailability, type HeartbeatPolicy } from './monitor.js';

const policy: HeartbeatPolicy = { expectedIntervalMs: 5000, missedHeartbeatLimit: 3, timeoutMs: 15000 };
const at = new Date('2026-01-01T12:00:00.000Z');

test('three missed heartbeat intervals mark a device unavailable', () => {
  assert.equal(heartbeatHealth('HEALTHY', new Date(at.getTime() - 14999), at, at, policy), 'HEALTHY');
  assert.equal(heartbeatHealth('HEALTHY', new Date(at.getTime() - 15000), at, at, policy), 'UNAVAILABLE');
  assert.equal(heartbeatHealth('HEALTHY', null, new Date(at.getTime() - 15000), at, policy), 'UNAVAILABLE');
  assert.equal(heartbeatHealth('UNAVAILABLE', new Date(at.getTime() - 5000), at, at, policy), 'HEALTHY');
  assert.equal(heartbeatHealth('DEGRADED', new Date(at.getTime() - 5000), at, at, policy), 'DEGRADED');
});

test('service status reflects the active device, not standby readiness', () => {
  assert.equal(serviceAvailability([{ health: 'HEALTHY', activationState: 'ACTIVE' }, { health: 'UNAVAILABLE', activationState: 'STANDBY' }]), 'AVAILABLE');
  assert.equal(serviceAvailability([{ health: 'UNAVAILABLE', activationState: 'ACTIVE' }, { health: 'HEALTHY', activationState: 'STANDBY' }]), 'OUTAGE');
  assert.equal(serviceAvailability([{ health: 'DEGRADED', activationState: 'ACTIVE' }]), 'DEGRADED');
  assert.equal(serviceAvailability([{ health: 'HEALTHY', activationState: 'ACTIVE' }, { health: 'HEALTHY', activationState: 'ACTIVE' }]), 'OUTAGE');
});

test('monitor persists heartbeat loss and service outage, then recovery', async () => {
  const active = { id: 'a', code: 'TEST-P', health: 'HEALTHY' as const, activationState: 'ACTIVE', createdAt: new Date(at.getTime() - 60000), heartbeats: [{ recordedAt: new Date(at.getTime() - 20000) }] };
  const standby = { id: 'b', code: 'TEST-S', health: 'HEALTHY' as const, activationState: 'STANDBY', createdAt: new Date(at.getTime() - 60000), heartbeats: [{ recordedAt: new Date(at.getTime() - 5000) }] };
  const state = { availability: 'AVAILABLE', activeHealth: 'HEALTHY', standbyHealth: 'HEALTHY' };
  const changes: unknown[] = [];
  const db = {
    logicalSystem: {
      findMany: async () => [{ id: 's', code: 'TEST', availability: state.availability, devices: [
        { ...active, health: state.activeHealth }, { ...standby, health: state.standbyHealth },
      ] }],
      update: async ({ data }: { data: { availability: string } }) => { state.availability = data.availability; },
    },
    device: { update: async ({ where, data }: { where: { id: string }; data: { health: string } }) => {
      if (where.id === 'a') state.activeHealth = data.health;
      else state.standbyHealth = data.health;
    } },
    $transaction: async (fn: (transaction: unknown) => Promise<void>) => fn(db),
  } as unknown as Database;
  const monitor = new HeartbeatMonitor(db, policy, change => changes.push(change));
  const loss = await monitor.check(at);
  assert.deepEqual(loss?.deviceCodes, ['TEST-P']);
  assert.deepEqual(loss?.systemCodes, ['TEST']);
  assert.equal(state.availability, 'OUTAGE');
  assert.equal(changes.length, 1);
  active.heartbeats[0]!.recordedAt = new Date(at.getTime() + 1000);
  const recovery = await monitor.check(new Date(at.getTime() + 2000));
  assert.deepEqual(recovery?.deviceCodes, ['TEST-P']);
  assert.equal(state.availability, 'AVAILABLE');
  assert.equal(await monitor.check(new Date(at.getTime() + 3000)), null);
});
