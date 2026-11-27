import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';
import { heartbeatHealth, serviceAvailability, type HeartbeatPolicy } from '../heartbeat/monitor.js';
import { MaintenanceError } from './service.js';

export async function maintenanceAction(db: Database, id: string, actor: Pick<PublicUser, 'id' | 'role'>,
  policy: HeartbeatPolicy, action: 'start' | 'approve', at = new Date()) {
  const startedAt = Date.now();
  const preview = await db.maintenanceWorkOrder.findUnique({ where: { id }, select: { systemId: true } });
  if (!preview) throw new MaintenanceError('NOT_FOUND', 'Work order not found');
  return db.$transaction(async tx => {
    // Lock order for every assignment operation: logical system, work order, devices sorted by id.
    await tx.$queryRaw`SELECT "id" FROM "LogicalSystem" WHERE "id" = ${preview.systemId}::uuid FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Device" WHERE "systemId" = ${preview.systemId}::uuid ORDER BY "id" FOR NO KEY UPDATE`;
    const order = await tx.maintenanceWorkOrder.findUniqueOrThrow({ where: { id }, include: { checklistItems: true } });
    const user = await tx.user.findUnique({ where: { id: actor.id } });
    if (!user?.active || user.role !== actor.role) throw new MaintenanceError('FORBIDDEN', 'Active authorized actor required');
    const manager = ['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role);
    if (!manager && (action === 'approve' || order.assignedEngineerId !== actor.id)) throw new MaintenanceError('FORBIDDEN', 'Assigned engineer or supervisor required');
    const system = await tx.logicalSystem.findUniqueOrThrow({ where: { id: order.systemId }, include: { devices: { include: { heartbeats: { take: 1, orderBy: { recordedAt: 'desc' } } } } } });
    const target = system.devices.find(device => device.id === order.deviceId)!;
    const ready = (device: typeof target) => device.maintenanceEligible && device.maintenanceStatus === 'AVAILABLE' &&
      device.health === 'HEALTHY' && !!device.heartbeats[0] && at.getTime() - device.heartbeats[0].recordedAt.getTime() >= 0 &&
      at.getTime() - device.heartbeats[0].recordedAt.getTime() < policy.timeoutMs;
    let toStatus: 'IN_PROGRESS' | 'COMPLETED';
    if (action === 'start') {
      if (!['ASSIGNED', 'SCHEDULED'].includes(order.status) || order.maintenanceModeAt || target.maintenanceStatus !== 'AVAILABLE')
        throw new MaintenanceError('INVALID_TRANSITION', 'Work order or device already in maintenance');
      const otherMaintained = system.devices.some(device => device.id !== target.id && device.maintenanceStatus !== 'AVAILABLE');
      if (otherMaintained && order.type === 'PREVENTIVE') throw new MaintenanceError('MAINTENANCE_CONFLICT', 'Concurrent preventive maintenance is unsafe');
      const active = target.activationState === 'ACTIVE';
      const standby = system.devices.find(device => device.id !== target.id && device.activationState === 'STANDBY' && ready(device));
      if (active && !standby && (order.type === 'PREVENTIVE' || target.health !== 'UNAVAILABLE'))
        throw new MaintenanceError('STANDBY_NOT_READY', 'Healthy eligible standby with fresh heartbeat required');
      if (!active && order.type === 'PREVENTIVE' && !system.devices.some(device => device.id !== target.id && device.activationState === 'ACTIVE' && ready(device)))
        throw new MaintenanceError('ACTIVE_NOT_READY', 'Preventive standby maintenance requires available active service');
      await tx.device.update({ where: { id: target.id }, data: { activationState: 'INELIGIBLE', maintenanceStatus: 'IN_PROGRESS', maintenanceEligible: false } });
      if (active && standby) {
        await tx.device.update({ where: { id: standby.id }, data: { activationState: 'ACTIVE' } });
        await tx.failoverEvent.create({ data: { systemId: system.id, fromDeviceId: target.id, toDeviceId: standby.id,
          initiatedById: actor.id, action: 'PLANNED_MAINTENANCE', result: 'SUCCESS', reason: 'Authorized simulated planned maintenance',
          detectedAt: at, completedAt: new Date(), durationMs: Math.max(0, Date.now() - startedAt), simulated: true } });
      }
      const states = system.devices.map(device => ({
        health: device.id === target.id ? device.health : heartbeatHealth(device.health, device.heartbeats[0]?.recordedAt ?? null, device.createdAt, at, policy),
        activationState: device.id === target.id ? 'INELIGIBLE' : active && standby?.id === device.id ? 'ACTIVE' : device.activationState,
      }));
      await tx.logicalSystem.update({ where: { id: system.id }, data: { availability: serviceAvailability(states) } });
      await tx.maintenanceWorkOrder.update({ where: { id }, data: { status: 'IN_PROGRESS', actualStartAt: at, maintenanceModeAt: at } });
      toStatus = 'IN_PROGRESS';
    } else {
      if (order.status !== 'VERIFICATION' || !order.maintenanceModeAt || target.maintenanceStatus !== 'IN_PROGRESS' ||
        !order.verificationResult || order.checklistItems.some(item => !item.completed || !item.result || item.result === 'FAILED'))
        throw new MaintenanceError('VERIFICATION_REQUIRED', 'Successful post-maintenance verification required');
      const recoveredHealth = heartbeatHealth(target.health, target.heartbeats[0]?.recordedAt ?? null, target.createdAt, at, policy);
      if (recoveredHealth !== 'HEALTHY' || !target.heartbeats[0] || at.getTime() - target.heartbeats[0].recordedAt.getTime() < 0 ||
        at.getTime() - target.heartbeats[0].recordedAt.getTime() >= policy.timeoutMs)
        throw new MaintenanceError('DEVICE_NOT_READY', 'Healthy equipment and fresh heartbeat required for eligibility restoration');
      await tx.device.update({ where: { id: target.id }, data: { health: recoveredHealth, maintenanceStatus: 'AVAILABLE', maintenanceEligible: true, activationState: 'STANDBY' } });
      await tx.maintenanceWorkOrder.update({ where: { id }, data: { status: 'COMPLETED', actualCompletionAt: at, completedAt: at } });
      if (order.planId) await tx.maintenancePlan.update({ where: { id: order.planId }, data: { lastCompletedAt: at } });
      toStatus = 'COMPLETED';
    }
    await tx.workOrderStatusHistory.create({ data: { workOrderId: id, actorId: actor.id, fromStatus: order.status, toStatus, note: 'Simulated maintenance ' + action, createdAt: at } });
    await tx.auditEvent.create({ data: { actorId: actor.id, actorRole: actor.role, method: 'POST', path: '/api/v1/maintenance/work-orders/' + id + '/' + action, statusCode: 200, occurredAt: at } });
    return { order: await tx.maintenanceWorkOrder.findUniqueOrThrow({ where: { id } }), deviceCodes: system.devices.map(device => device.code), systemCodes: [system.code], checkedAt: at.toISOString(), simulated: true as const };
  }, { maxWait: 15000, timeout: 30000 });
}
