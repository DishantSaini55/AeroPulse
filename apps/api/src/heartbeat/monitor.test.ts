import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heartbeatHealth, serviceAvailability, type HeartbeatPolicy } from './monitor.js';

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

