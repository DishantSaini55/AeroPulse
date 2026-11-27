import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';
import { heartbeatPolicyFromEnv, type HeartbeatPolicy } from '../heartbeat/monitor.js';
import { calculateReliability } from '../analytics/metrics.js';
import { recordedAnalyticsInput } from '../analytics/source.js';
import { MaintenanceError } from './service.js';

const finalStates = ['COMPLETED', 'CANCELLED'];
const money = z.number().min(0).max(9999999999.99).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, 'Use at most two decimal places');
const windowInput = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
function windowFor(query: unknown) {
  const input = windowInput.parse(query);
  const to = input.to ? new Date(input.to + 'T23:59:59.999Z') : new Date();
  const from = input.from ? new Date(input.from + 'T00:00:00.000Z') : new Date(to.getTime() - 30 * 86400000);
  if (from > to || to.getTime() - from.getTime() > 366 * 86400000) throw new MaintenanceError('INVALID_WINDOW', 'Choose a UTC range of at most 366 days');
  return { from, to };
}
export function workOrderCosts(order: { parts: Array<{ quantity: number; unitCost: Prisma.Decimal }>; laborCost: Prisma.Decimal; otherCost: Prisma.Decimal }) {
  const parts = order.parts.reduce((sum, item) => sum.plus(item.unitCost.mul(item.quantity)), new Prisma.Decimal(0));
  return { parts: parts.toNumber(), labor: order.laborCost.toNumber(), other: order.otherCost.toNumber(), total: parts.plus(order.laborCost).plus(order.otherCost).toNumber() };
}
export function maintenanceWorkspaceRoutes(db: Database, policy: HeartbeatPolicy = heartbeatPolicyFromEnv()) {
  const router = Router();
  router.get('/options', async (_request, response) => {
    const [devices, engineers] = await Promise.all([
      db.device.findMany({ orderBy: { code: 'asc' }, include: { system: { select: { code: true, name: true } } } }),
      db.user.findMany({ where: { role: 'MAINTENANCE_ENGINEER', active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    response.json({ data: { devices, engineers }, simulated: true });
  });
  router.get('/workspace/orders', async (request, response) => {
    const input = z.object({ search: z.string().max(200).default(''), status: z.enum(['DRAFT','SCHEDULED','ASSIGNED','IN_PROGRESS','ON_HOLD','VERIFICATION','COMPLETED','CANCELLED','REJECTED']).optional(),
      type: z.enum(['PREVENTIVE','CORRECTIVE','INSPECTION','COMPONENT_REPLACEMENT','EQUIPMENT_REPLACEMENT']).optional(), device: z.string().max(48).optional(),
      engineerId: z.uuid().optional(), sort: z.enum(['scheduled','created','priority']).default('created'), direction: z.enum(['asc','desc']).default('desc'),
      page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).safeParse(request.query);
    if (!input.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work-order filters' } }); return; }
    const filter = input.data;
    const where: Prisma.MaintenanceWorkOrderWhereInput = { status: filter.status, type: filter.type, assignedEngineerId: filter.engineerId,
      device: filter.device ? { code: filter.device } : undefined,
      OR: filter.search ? [{ title: { contains: filter.search, mode: 'insensitive' } }, { description: { contains: filter.search, mode: 'insensitive' } }, { device: { code: { contains: filter.search, mode: 'insensitive' } } }] : undefined };
    const orderBy: Prisma.MaintenanceWorkOrderOrderByWithRelationInput = filter.sort === 'scheduled' ? { scheduledStartAt: { sort: filter.direction, nulls: 'last' } } : filter.sort === 'priority' ? { priority: filter.direction } : { createdAt: filter.direction };
    const [total, data] = await db.$transaction([db.maintenanceWorkOrder.count({ where }), db.maintenanceWorkOrder.findMany({ where, orderBy: [orderBy, { id: 'asc' }],
      skip: (filter.page - 1) * filter.limit, take: filter.limit, include: { device: { select: { code: true, name: true } }, assignedEngineer: { select: { id: true, name: true } } } })], { isolationLevel: 'RepeatableRead' });
    response.json({ data, total, page: filter.page, limit: filter.limit, simulated: true });
  });
  router.get('/work-orders/:id/readiness', async (request, response) => {
    if (!z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; }
    const order = await db.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) }, include: { system: { include: { devices: { include: { heartbeats: { take: 1, orderBy: { recordedAt: 'desc' } } } } } } } });
    if (!order) throw new MaintenanceError('NOT_FOUND', 'Work order not found');
    const actor = response.locals.user as PublicUser;
    const now = Date.now();
    const devices = order.system.devices.map(({ heartbeats, ...device }) => ({ ...device, latestHeartbeatAt: heartbeats[0]?.recordedAt ?? null,
      heartbeatFresh: !!heartbeats[0] && now - heartbeats[0].recordedAt.getTime() >= 0 && now - heartbeats[0].recordedAt.getTime() < policy.timeoutMs }));
    const target = devices.find(device => device.id === order.deviceId);
    const ready = (device: typeof devices[number]) => device.health === 'HEALTHY' && device.heartbeatFresh && device.maintenanceEligible && device.maintenanceStatus === 'AVAILABLE';
    const reasons: string[] = [];
    if (actor.role === 'MAINTENANCE_ENGINEER' && order.assignedEngineerId !== actor.id) reasons.push('Only the assigned engineer or a supervisor can start this work order.');
    if (!['ASSIGNED', 'SCHEDULED'].includes(order.status) || order.maintenanceModeAt) reasons.push('Only an unstarted assigned or scheduled work order can begin.');
    if (!target || target.maintenanceStatus !== 'AVAILABLE') reasons.push('Target equipment is already undergoing maintenance or is inconsistent with its system.');
    if (order.type === 'PREVENTIVE' && devices.some(device => device.id !== order.deviceId && device.maintenanceStatus !== 'AVAILABLE')) reasons.push('Another device in this logical system is undergoing maintenance.');
    const standby = devices.find(device => device.id !== order.deviceId && device.activationState === 'STANDBY' && ready(device));
    if (target?.activationState === 'ACTIVE' && !standby && (order.type === 'PREVENTIVE' || target.health !== 'UNAVAILABLE')) reasons.push('A healthy, eligible standby with a fresh heartbeat is required.');
    if (target?.activationState !== 'ACTIVE' && order.type === 'PREVENTIVE' && !devices.some(device => device.id !== order.deviceId && device.activationState === 'ACTIVE' && ready(device))) reasons.push('Preventive standby maintenance requires a healthy active device.');
    response.json({ data: { canStart: reasons.length === 0, blockingReasons: reasons, plannedSwitch: target?.activationState === 'ACTIVE' && !!standby, standbyCode: standby?.code ?? null,
      devices, policy, checkedAt: new Date(now).toISOString(), previewOnly: true }, simulated: true });
  });
  router.patch('/work-orders/:id/costs', async (request, response) => {
    const input = z.strictObject({ laborCost: money, otherCost: money }).safeParse(request.body);
    if (!z.uuid().safeParse(request.params.id).success || !input.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid two-decimal costs required' } }); return; }
    const id = String(request.params.id);
    const actor = response.locals.user as PublicUser;
    const data = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const order = await tx.maintenanceWorkOrder.findUnique({ where: { id } });
      if (!order) throw new MaintenanceError('NOT_FOUND', 'Work order not found');
      if (finalStates.includes(order.status)) throw new MaintenanceError('FINALIZED', 'Finalized work orders are immutable');
      if (actor.role === 'MAINTENANCE_ENGINEER' && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only the assigned engineer or a supervisor may change costs');
      const updated = await tx.maintenanceWorkOrder.update({ where: { id }, data: input.data, include: { parts: true } });
      return workOrderCosts(updated);
    });
    response.json({ data, simulated: true });
  });
  router.get('/calendar', async (request, response) => {
    let range;
    try { range = windowFor(request.query); } catch { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid UTC date range' } }); return; }
    const [orders, plans] = await Promise.all([
      db.maintenanceWorkOrder.findMany({ where: { status: { notIn: ['CANCELLED','REJECTED'] }, scheduledStartAt: { gte: range.from, lte: range.to } }, orderBy: { scheduledStartAt: 'asc' }, take: 501, include: { device: { select: { code: true } }, assignedEngineer: { select: { name: true } } } }),
      db.maintenancePlan.findMany({ where: { active: true, nextScheduledAt: { gte: range.from, lte: range.to } }, orderBy: { nextScheduledAt: 'asc' }, take: 501, include: { device: { select: { code: true } }, assignedEngineer: { select: { name: true } } } }),
    ]);
    response.json({ data: { orders: orders.slice(0,500), plans: plans.slice(0,500), truncated: orders.length > 500 || plans.length > 500 }, simulated: true });
  });
  router.get('/overview', async (request, response) => {
    let range;
    try { range = windowFor(request.query); } catch { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid UTC date range' } }); return; }
    const now = new Date();
    const [orders, deviceCount, reliability, plannedSchedule] = await Promise.all([
      db.maintenanceWorkOrder.findMany({ where: { OR: [{ createdAt: { gte: range.from, lte: range.to } }, { scheduledStartAt: { gte: range.from, lte: range.to } }, { completedAt: { gte: range.from, lte: range.to } }] },
        include: { parts: true, device: { select: { code: true, system: { select: { code: true } } } }, assignedEngineer: { select: { id: true, name: true } } } }),
      db.device.count({ where: { maintenanceStatus: { not: 'AVAILABLE' } } }),
      recordedAnalyticsInput(db, range.from, range.to, policy.expectedIntervalMs).then(input => calculateReliability(input, range.from, range.to, 'RECORDED')),
      db.maintenancePlan.findMany({ where: { active: true, nextScheduledAt: { gte: range.from, lte: range.to } }, select: { nextScheduledAt: true } }),
    ]);
    const due = orders.filter(order => order.type === 'PREVENTIVE' && order.scheduledStartAt && order.scheduledStartAt >= range.from && order.scheduledStartAt <= range.to && order.scheduledStartAt <= now && order.status !== 'CANCELLED');
    const onTime = due.filter(order => order.completedAt && order.completedAt <= (order.scheduledCompletionAt ?? order.scheduledStartAt!));
    const finished = orders.filter(order => order.completedAt && order.completedAt >= range.from && order.completedAt <= range.to && order.actualStartAt);
    const workload = new Map<string, { id: string; name: string; active: number; completed: number }>();
    const expenditure = new Map<string, Prisma.Decimal>();
    const systems = new Map<string, Prisma.Decimal>();
    let total = new Prisma.Decimal(0);
    for (const order of orders) {
      const cost = order.parts.reduce((sum, part) => sum.plus(part.unitCost.mul(part.quantity)), order.laborCost.plus(order.otherCost));
      total = total.plus(cost);
      expenditure.set(order.device.code, (expenditure.get(order.device.code) ?? new Prisma.Decimal(0)).plus(cost));
      systems.set(order.device.system.code, (systems.get(order.device.system.code) ?? new Prisma.Decimal(0)).plus(cost));
      if (order.assignedEngineer) {
        const row = workload.get(order.assignedEngineer.id) ?? { ...order.assignedEngineer, active: 0, completed: 0 };
        if (order.status === 'COMPLETED') row.completed++; else if (!finalStates.includes(order.status) && order.status !== 'REJECTED') row.active++;
        workload.set(row.id, row);
      }
    }
    response.json({ data: { from: range.from, to: range.to, generatedAt: now, devicesUnderMaintenance: deviceCount,
      upcomingPlans: plannedSchedule.filter(plan => plan.nextScheduledAt > now).length, overduePlans: plannedSchedule.filter(plan => plan.nextScheduledAt <= now).length,
      upcoming: orders.filter(order => !finalStates.includes(order.status) && order.status !== 'REJECTED' && order.scheduledStartAt && order.scheduledStartAt > now).length,
      overdue: orders.filter(order => !finalStates.includes(order.status) && order.status !== 'REJECTED' && order.scheduledStartAt && (order.scheduledCompletionAt ?? order.scheduledStartAt) < now).length,
      active: orders.filter(order => !finalStates.includes(order.status) && order.status !== 'REJECTED').length, completed: orders.filter(order => order.status === 'COMPLETED').length,
      compliance: { numerator: onTime.length, denominator: due.length, percent: due.length ? onTime.length / due.length * 100 : null },
      averageCompletionMs: finished.length ? finished.reduce((sum, order) => sum + Math.max(0, order.completedAt!.getTime() - order.actualStartAt!.getTime()), 0) / finished.length : null,
      completionSamples: finished.length, totalExpenditure: total.toFixed(2),
      distribution: { preventive: orders.filter(order => order.type === 'PREVENTIVE').length, corrective: orders.filter(order => order.type === 'CORRECTIVE').length, other: orders.filter(order => !['PREVENTIVE','CORRECTIVE'].includes(order.type)).length },
      engineerWorkload: [...workload.values()], expenditureByDevice: [...expenditure].map(([code, amount]) => ({ code, amount: amount.toFixed(2) })),
      expenditureBySystem: [...systems].map(([code, amount]) => ({ code, amount: amount.toFixed(2) })),
      plannedEquipmentDowntimeMs: reliability.summary.plannedEquipmentUnavailabilityMs, unplannedEquipmentDowntimeMs: reliability.summary.equipmentDowntimeMs,
      serviceAvailabilityPct: reliability.summary.serviceAvailabilityPct, serviceObservedMs: reliability.coverage.observedServiceMs,
      formulas: { compliance: 'On-time completed preventive orders / non-cancelled preventive orders due in selected range through now; completion deadline = scheduledCompletionAt or scheduledStartAt.',
        completion: 'Mean completedAt - actualStartAt for completions in range; no samples = unavailable.',
        expenditure: 'Current persisted parts quantity x Decimal unit cost + labor + other for orders created, scheduled or completed in range; not a payment-date ledger.',
        workload: 'Non-final, non-rejected assigned orders within the same selected order cohort.',
        availability: 'Recorded observed service intervals from existing reliability analytics; planned maintenance is not an equipment failure.' } }, simulated: true });
  });
  return router;
}
