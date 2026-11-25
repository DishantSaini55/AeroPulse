import type { Database } from '../db.js';
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

export class HeartbeatMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<StatusChange | null>;
  constructor(private readonly db: Database, readonly policy: HeartbeatPolicy, private readonly onChange?: (change: StatusChange) => void) {}

  async check(at = new Date()): Promise<StatusChange | null> {
    const systems = await this.db.logicalSystem.findMany({
      include: { devices: { include: { heartbeats: { take: 1, orderBy: { recordedAt: 'desc' } } } } },
    });
    const deviceCodes: string[] = [];
    const systemCodes: string[] = [];
    for (const system of systems) {
      const assessed = system.devices.map(device => ({
        device, health: heartbeatHealth(device.health, device.heartbeats[0]?.recordedAt ?? null, device.createdAt, at, this.policy),
      }));
      const availability = serviceAvailability(assessed.map(({ device, health }) => ({ health, activationState: device.activationState })));
      const changedDevices = assessed.filter(({ device, health }) => health !== device.health);
      if (changedDevices.length === 0 && availability === system.availability) continue;
      await this.db.$transaction(async transaction => {
        for (const { device, health } of changedDevices) {
          await transaction.device.update({ where: { id: device.id }, data: { health } });
          deviceCodes.push(device.code);
        }
        if (availability !== system.availability) {
          await transaction.logicalSystem.update({ where: { id: system.id }, data: { availability } });
          systemCodes.push(system.code);
        }
      });
    }
    if (!deviceCodes.length && !systemCodes.length) return null;
    const change = { deviceCodes, systemCodes, checkedAt: at.toISOString(), simulated: true as const };
    this.onChange?.(change);
    return change;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.pending) return;
      this.pending = this.check().catch(error => { console.error('Heartbeat check failed', error); return null; }).finally(() => { this.pending = undefined; });
    }, this.policy.expectedIntervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
