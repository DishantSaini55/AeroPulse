import type { Database } from '../db.js';
import { heartbeatHealth, serviceAvailability, type HeartbeatPolicy, type StatusChange } from '../heartbeat/monitor.js';

export class FailbackError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'PRIMARY_NOT_READY' | 'NO_STANDBY_ACTIVE', message: string) { super(message); }
}

export class RedundancyManager {
  private timer?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<StatusChange | null>;
  constructor(private readonly db: Database, readonly policy: HeartbeatPolicy, private readonly onChange?: (change: StatusChange) => void) {}

  async check(at = new Date(), systemId?: string): Promise<StatusChange | null> {
    const systems = await this.db.logicalSystem.findMany({
      where: systemId ? { id: systemId } : undefined,
      include: { devices: { include: { heartbeats: { take: 1, orderBy: { recordedAt: 'desc' } } } } },
    });
    const deviceCodes: string[] = [];
    const systemCodes: string[] = [];
    for (const preview of systems) {
      const id = preview.id;
      const previewDevices = preview.devices.map(device => {
        const health = heartbeatHealth(device.health, device.heartbeats[0]?.recordedAt ?? null, device.createdAt, at, this.policy);
        return { health, activationState: device.activationState, changed: health !== device.health };
      });
      if (!previewDevices.some(device => device.changed) && serviceAvailability(previewDevices) === preview.availability) continue;
      const changed = await this.db.$transaction(async transaction => {
        // Assignment writers lock the same row; the partial unique index remains the final guard.
        await transaction.$queryRaw`SELECT "id" FROM "LogicalSystem" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const system = await transaction.logicalSystem.findUniqueOrThrow({
          where: { id }, include: { devices: { include: { heartbeats: { take: 1, orderBy: { recordedAt: 'desc' } } } } },
        });
        const assessed = system.devices.map(device => ({
          device, health: heartbeatHealth(device.health, device.heartbeats[0]?.recordedAt ?? null, device.createdAt, at, this.policy),
        }));
        const active = assessed.find(item => item.device.activationState === 'ACTIVE');
        const activeJustFailed = active?.health === 'UNAVAILABLE' && active.device.health !== 'UNAVAILABLE';
        const standby = assessed.find(item => item.device.activationState === 'STANDBY' && item.health === 'HEALTHY');
        const changedCodes: string[] = [];
        for (const { device, health } of assessed) {
          if (health === device.health) continue;
          await transaction.device.update({ where: { id: device.id }, data: { health } });
          changedCodes.push(device.code);
        }
        let failedOver = false;
        if (activeJustFailed && active) {
          const started = Date.now();
          if (standby) {
            await transaction.device.update({ where: { id: active.device.id }, data: { activationState: 'INELIGIBLE' } });
            await transaction.device.update({ where: { id: standby.device.id }, data: { activationState: 'ACTIVE' } });
            changedCodes.push(active.device.code, standby.device.code);
            failedOver = true;
          }
          await transaction.failoverEvent.create({ data: {
            systemId: id, fromDeviceId: active.device.id, toDeviceId: standby?.device.id,
            action: 'AUTOMATIC_FAILOVER', result: standby ? 'SUCCESS' : 'NO_HEALTHY_STANDBY',
            reason: standby ? 'Active device missed heartbeat threshold; healthy standby activated' : 'Active device missed heartbeat threshold; no healthy standby available',
            detectedAt: at, completedAt: new Date(), durationMs: Math.max(0, Date.now() - started), simulated: true,
          } });
        }
        const availability = serviceAvailability(assessed.map(({ device, health }) => ({
          health, activationState: failedOver && device.id === active?.device.id ? 'INELIGIBLE' : failedOver && device.id === standby?.device.id ? 'ACTIVE' : device.activationState,
        })));
        if (availability !== system.availability) await transaction.logicalSystem.update({ where: { id }, data: { availability } });
        return { code: system.code, changedCodes, changed: changedCodes.length > 0 || availability !== system.availability };
      }, { maxWait: 15000, timeout: 30000 });
      deviceCodes.push(...changed.changedCodes);
      if (changed.changed) systemCodes.push(changed.code);
    }
    if (!systemCodes.length) return null;
    const change = { deviceCodes: [...new Set(deviceCodes)], systemCodes, checkedAt: at.toISOString(), simulated: true as const };
    this.onChange?.(change);
    return change;
  }

  async failback(systemCode: string, userId: string, at = new Date()) {
    const result = await this.db.$transaction(async transaction => {
      const systemId = await transaction.logicalSystem.findUnique({ where: { code: systemCode }, select: { id: true } });
      if (!systemId) throw new FailbackError('NOT_FOUND', 'System not found');
      await transaction.$queryRaw`SELECT "id" FROM "LogicalSystem" WHERE "id" = ${systemId.id}::uuid FOR UPDATE`;
      const system = await transaction.logicalSystem.findUniqueOrThrow({
        where: { id: systemId.id }, include: { devices: { include: { heartbeats: { take: 1, orderBy: { recordedAt: 'desc' } } } } },
      });
      const primary = system.devices.find(device => device.role === 'PRIMARY');
      const secondary = system.devices.find(device => device.role === 'SECONDARY' && device.activationState === 'ACTIVE');
      if (!secondary) throw new FailbackError('NO_STANDBY_ACTIVE', 'Secondary device is not active');
      if (!primary || heartbeatHealth(primary.health, primary.heartbeats[0]?.recordedAt ?? null, primary.createdAt, at, this.policy) !== 'HEALTHY') {
        throw new FailbackError('PRIMARY_NOT_READY', 'Primary device is not healthy with a recent heartbeat');
      }
      const started = Date.now();
      await transaction.device.update({ where: { id: secondary.id }, data: { activationState: 'STANDBY' } });
      await transaction.device.update({ where: { id: primary.id }, data: { activationState: 'ACTIVE' } });
      await transaction.logicalSystem.update({ where: { id: system.id }, data: { availability: 'AVAILABLE' } });
      const event = await transaction.failoverEvent.create({ data: {
        systemId: system.id, fromDeviceId: secondary.id, toDeviceId: primary.id, initiatedById: userId,
        action: 'MANUAL_FAILBACK', result: 'SUCCESS', reason: 'Authorized manual failback to recovered primary',
        detectedAt: at, completedAt: new Date(), durationMs: Math.max(0, Date.now() - started), simulated: true,
      } });
      return { event, codes: [primary.code, secondary.code], systemCode: system.code };
    }, { maxWait: 15000, timeout: 30000 });
    this.onChange?.({ deviceCodes: result.codes, systemCodes: [result.systemCode], checkedAt: at.toISOString(), simulated: true });
    return result.event;
  }

  start() {
    if (this.timer || this.startupTimer) return;
    const run = () => {
      if (this.pending) return;
      this.pending = this.check().catch(error => { console.error('Redundancy check failed', error); return null; }).finally(() => { this.pending = undefined; });
    };
    // Check one second after the simulator cadence, allowing its heartbeat transaction to commit.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      run();
      this.timer = setInterval(run, this.policy.expectedIntervalMs);
    }, 1000);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = undefined;
    this.startupTimer = undefined;
    await this.pending;
  }
}
