import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';
import { MaintenanceError } from './service.js';

export type MaintenanceAnnouncement = {
  id: string; kind: string; level: 'INFORMATION' | 'WARNING'; message: string; createdAt: string;
  deviceCode: string; systemCode: string; href: string; simulated: true;
};
const unsafeCodes = new Set(['STANDBY_NOT_READY', 'ACTIVE_NOT_READY', 'MAINTENANCE_CONFLICT']);

// A rejected transaction has no success event. Persist its authorized safety rejection separately.
export async function recordUnsafeStart(db: Database, id: string, actor: PublicUser, error: unknown) {
  if (!(error instanceof MaintenanceError) || !unsafeCodes.has(error.code)) return false;
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const order = await tx.maintenanceWorkOrder.findUnique({ where: { id } });
    if (!order || (!['SUPERVISOR','ADMINISTRATOR'].includes(actor.role) && order.assignedEngineerId !== actor.id)) return false;
    await tx.workOrderStatusHistory.create({ data: { workOrderId: id, actorId: actor.id,
      fromStatus: order.status, toStatus: order.status, note: `Unsafe start rejected: ${error.code}. ${error.message}` } });
    return true;
  });
}

// This bounded read model reuses committed operational records; it is not a delivery outbox.
export async function maintenanceAnnouncements(db: Database, actor: PublicUser, since: Date, at = new Date()) {
  const cap = 200;
  return db.$transaction(async tx => {
    // An interactive transaction has one PG connection; issue its queries sequentially.
    const history = await tx.workOrderStatusHistory.findMany({ where: { createdAt: { gte: since, lte: at },
        OR: [{ toStatus: { in: ['SCHEDULED','ASSIGNED','IN_PROGRESS','VERIFICATION','COMPLETED'] } },
          { note: { startsWith: 'Verification failed:' } }, { note: { startsWith: 'Unsafe start rejected:' } }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: cap + 1,
        include: { workOrder: { include: { device: { select: { code: true } }, system: { select: { code: true } } } } } });
    const switches = await tx.failoverEvent.findMany({ where: { action: 'PLANNED_MAINTENANCE', result: 'SUCCESS', completedAt: { gte: since, lte: at } },
        orderBy: [{ completedAt: 'desc' }, { id: 'asc' }], take: cap + 1,
        include: { system: { select: { code: true } }, fromDevice: { select: { code: true } }, toDevice: { select: { code: true } } } });
    const orders = await tx.maintenanceWorkOrder.findMany({ where: { status: { in: ['DRAFT','SCHEDULED','ASSIGNED'] },
        scheduledStartAt: { lte: new Date(at.getTime() + 7 * 86400000) } },
        orderBy: [{ scheduledStartAt: 'asc' }, { id: 'asc' }], take: cap + 1,
        include: { device: { select: { code: true } }, system: { select: { code: true } } } });
    const plans = await tx.maintenancePlan.findMany({ where: { active: true, nextScheduledAt: { gt: at, lte: new Date(at.getTime() + 366 * 86400000) } },
        orderBy: [{ nextScheduledAt: 'asc' }, { id: 'asc' }], take: cap + 1,
        include: { device: { select: { code: true } }, system: { select: { code: true } } } });
    const data: MaintenanceAnnouncement[] = [];
    const add = (id: string, kind: string, deviceCode: string, systemCode: string, message: string, createdAt: Date, href: string, warning = false) =>
      data.push({ id, kind, deviceCode, systemCode, message, createdAt: createdAt.toISOString(), href, level: warning ? 'WARNING' : 'INFORMATION', simulated: true });
    const manager = ['SUPERVISOR','ADMINISTRATOR'].includes(actor.role);
    for (const row of history.slice(0, cap)) {
      const order = row.workOrder, device = order.device.code, system = order.system.code, href = '/maintenance/orders/' + order.id;
      const key = 'maintenance-history:' + row.id;
      if (row.fromStatus === row.toStatus && row.note?.startsWith('Unsafe start rejected:')) {
        if (manager || row.actorId === actor.id) add(key, 'UNSAFE_START_REJECTED', device, system, `${system} ${device}: ${row.note} Equipment activation was not authorized by this attempt.`, row.createdAt, href, true);
      } else if (row.toStatus === 'ON_HOLD' && row.fromStatus !== 'VERIFICATION' && row.note?.startsWith('Verification failed:')) {
        add(key, 'VERIFICATION_FAILED', device, system, `${system} ${device}: maintenance verification failed. A hold was recorded; review the verification history for the current outcome.`, row.createdAt, href, true);
      } else if (row.fromStatus !== row.toStatus) {
        if (row.toStatus === 'ASSIGNED' || (row.toStatus === 'SCHEDULED' && !row.fromStatus && order.assignedEngineerId)) add(key, 'ASSIGNED', device, system, `${system} ${device}: maintenance assignment recorded for work order ${order.title}.`, row.createdAt, href);
        if (row.toStatus === 'IN_PROGRESS' && order.maintenanceModeAt) add(key, 'STARTED', device, system, `${system} ${device}: maintenance started. Service activation exclusion was recorded for this maintenance interval.`, row.createdAt, href);
        if (row.toStatus === 'VERIFICATION' && order.status === 'VERIFICATION' && manager) add(key, 'APPROVAL_REQUESTED', device, system, `${system} ${device}: maintenance verification submitted. Supervisor approval is required.`, row.createdAt, href);
        if (row.toStatus === 'COMPLETED' && order.completedAt && order.maintenanceModeAt) {
          add(key, 'COMPLETED', device, system, `${system} ${device}: maintenance completion approved and recorded.`, row.createdAt, href);
          add(key + ':eligibility', 'ELIGIBILITY_RESTORED', device, system, `${system} ${device}: standby eligibility restoration was recorded after verification. Active service assignment remains a separate controlled operation.`, row.createdAt, href);
        }
      }
    }
    for (const row of switches.slice(0, cap)) if (row.fromDevice && row.toDevice)
      add('maintenance-switch:' + row.id, 'PLANNED_FAILOVER', row.fromDevice.code, row.system.code,
        `${row.system.code}: planned maintenance switch from ${row.fromDevice.code} to ${row.toDevice.code} completed successfully.`, row.completedAt, '/redundancy');
    for (const order of orders.slice(0, cap)) {
      const due = order.scheduledStartAt!;
      const overdue = due <= at;
      const occurrence = order.planId ? `${order.planId}:${due.toISOString()}` : order.id;
      add(`maintenance-due:${occurrence}:${overdue ? 'overdue' : 'upcoming'}`, overdue ? 'OVERDUE' : 'UPCOMING', order.device.code, order.system.code,
        `${order.system.code} ${order.device.code}: maintenance ${order.title} is ${overdue ? 'overdue' : 'upcoming'}, scheduled ${due.toISOString()} UTC.`, due, '/maintenance/orders/' + order.id, overdue);
    }
    for (const plan of plans.slice(0, cap)) if (plan.nextScheduledAt.getTime() - at.getTime() <= plan.advanceNoticeDays * 86400000)
      add(`maintenance-due:${plan.id}:${plan.nextScheduledAt.toISOString()}:upcoming`, 'UPCOMING', plan.device.code, plan.system.code,
        `${plan.system.code} ${plan.device.code}: maintenance plan ${plan.name} is due ${plan.nextScheduledAt.toISOString()} UTC.`, plan.nextScheduledAt, '/maintenance/plans/' + plan.id + '/edit');
    return { data: [...new Map(data.map(row => [row.id,row])).values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      truncated: [history,switches,orders,plans].some(rows => rows.length > cap), generatedAt: at.toISOString(), simulated: true as const };
  }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 });
}

export function maintenanceAnnouncementRoutes(db: Database) {
  const router = Router();
  router.get('/announcements', async (request, response) => {
    const parsed = z.strictObject({ since: z.iso.datetime().optional() }).safeParse(request.query);
    const at = new Date();
    const since = parsed.success && parsed.data.since ? new Date(parsed.data.since) : new Date(at.getTime() - 120000);
    if (!parsed.success || since > at || at.getTime() - since.getTime() > 86400000) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose a UTC announcement start within the last 24 hours' } }); return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.json(await maintenanceAnnouncements(db, response.locals.user as PublicUser, since, at));
  });
  return router;
}
