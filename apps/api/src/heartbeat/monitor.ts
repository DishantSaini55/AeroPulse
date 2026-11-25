import type { DeviceHealth, ServiceAvailability } from '../generated/prisma/enums.js';

export type HeartbeatPolicy = { expectedIntervalMs: number; missedHeartbeatLimit: number; timeoutMs: number };
export type StatusChange = { deviceCodes: string[]; systemCodes: string[]; checkedAt: string; simulated: true };

export function heartbeatPolicyFromEnv(): HeartbeatPolicy {
  const expectedIntervalMs = 5000;
  const missedHeartbeatLimit = Number(process.env.HEARTBEAT_MISSED_LIMIT ?? 3);
  if (!Number.isInteger(missedHeartbeatLimit) || missedHeartbeatLimit < 1 || missedHeartbeatLimit > 12) {
    throw new Error('HEARTBEAT_MISSED_LIMIT must be an integer from 1 to 12');
  }
  return { expectedIntervalMs, missedHeartbeatLimit, timeoutMs: expectedIntervalMs * missedHeartbeatLimit };
}

export function heartbeatHealth(current: DeviceHealth, lastHeartbeatAt: Date | null, since: Date, at: Date, policy: HeartbeatPolicy): DeviceHealth {
  const latest = lastHeartbeatAt ?? since;
  if (at.getTime() - latest.getTime() >= policy.timeoutMs) return 'UNAVAILABLE';
  return current === 'UNAVAILABLE' ? 'HEALTHY' : current;
}

export function serviceAvailability(devices: { health: DeviceHealth; activationState: string }[]): ServiceAvailability {
  const active = devices.filter(device => device.activationState === 'ACTIVE');
  if (active.length !== 1 || active[0]!.health === 'UNAVAILABLE') return 'OUTAGE';
  return active[0]!.health === 'HEALTHY' ? 'AVAILABLE' : 'DEGRADED';
}

