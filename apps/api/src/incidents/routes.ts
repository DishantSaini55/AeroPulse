import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';
import { IncidentError, IncidentService } from './service.js';

const uuid = z.uuid();
const status = z.enum(['ACKNOWLEDGED', 'ASSIGNED', 'UNDER_INVESTIGATION', 'UNDER_REPAIR', 'VERIFICATION', 'RESOLVED']);
const text = z.string().trim().min(3).max(2000);
const money = z.number().min(0).max(9999999999).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, 'Use two decimal places');
const errorResponse = (response: { status: (code: number) => { json: (body: unknown) => void } }, message: string) => response.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
const duration = (start: Date, end: Date | null, now: Date) => Math.max(0, (end ?? now).getTime() - start.getTime());

export function incidentRoutes(db: Database, service: IncidentService) {
  const router = Router();

  router.get('/incidents', async (request, response) => {
    const input = z.object({ status: z.enum(['open', 'resolved', 'all']).default('open'), device: z.string().max(48).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query);
    if (!input.success) { errorResponse(response, 'Invalid incident filters'); return; }
    const incidents = await db.incident.findMany({
      where: { status: input.data.status === 'open' ? { not: 'RESOLVED' } : input.data.status === 'resolved' ? 'RESOLVED' : undefined,
        device: input.data.device ? { code: input.data.device } : undefined },
      take: input.data.limit, orderBy: { createdAt: 'desc' },
      include: { device: { select: { code: true, name: true, system: { select: { code: true, name: true } } } }, assignedTo: { select: { id: true, name: true } }, approvedBy: { select: { name: true } }, alarm: { select: { level: true, resolvedAt: true, diagnosis: { select: { confirmedRootCause: true } } } }, _count: { select: { repairs: true } } },
    });
    response.json({ data: incidents, simulated: true });
  });

  router.get('/incidents/engineers', async (_request, response) => {
    const engineers = await db.user.findMany({ where: { role: 'MAINTENANCE_ENGINEER', active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    response.json({ data: engineers });
  });

  router.get('/incidents/:id', async (request, response) => {
    const id = String(request.params.id);
    if (!uuid.safeParse(id).success) { errorResponse(response, 'Invalid incident ID'); return; }
    const incident = await db.incident.findUnique({ where: { id }, include: {
      device: { select: { code: true, name: true, system: { select: { code: true, name: true } } } },
      alarm: { select: { level: true, message: true, createdAt: true, resolvedAt: true, diagnosis: { select: { suspectedCause: true, confirmedRootCause: true, symptoms: true, supportingTelemetry: true } } } },
      assignedTo: { select: { id: true, name: true } }, approvedBy: { select: { name: true } },
      events: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { name: true } } } },
      repairs: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { name: true } } } },
    } });
    if (!incident) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Incident not found' } }); return; }
    response.json({ data: incident, simulated: true });
  });

  router.post('/incidents/:id/transition', async (request, response) => {
    const id = String(request.params.id);
    const input = z.strictObject({ status, assignedToId: uuid.optional() }).safeParse(request.body);
    if (!uuid.safeParse(id).success || !input.success) { errorResponse(response, 'Invalid status or assignment'); return; }
    const user = response.locals.user as PublicUser;
    const incident = await service.transition(id, input.data.status, user, input.data.assignedToId);
    response.json({ data: incident, simulated: true });
  });

  router.post('/incidents/:id/approve', async (request, response) => {
    const id = String(request.params.id);
    if (!uuid.safeParse(id).success) { errorResponse(response, 'Invalid incident ID'); return; }
    const incident = await service.approve(id, response.locals.user as PublicUser);
    response.json({ data: incident, simulated: true });
  });

  router.post('/incidents/:id/comments', async (request, response) => {
    const id = String(request.params.id);
    const input = z.strictObject({ message: text }).safeParse(request.body);
    if (!uuid.safeParse(id).success || !input.success) { errorResponse(response, 'Enter a comment of 3–2000 characters'); return; }
    const user = response.locals.user as PublicUser;
    const event = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Incident" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const incident = await tx.incident.findUnique({ where: { id }, select: { status: true, assignedToId: true } });
      if (!incident) throw new IncidentError('NOT_FOUND', 'Incident not found');
      if (incident.status === 'RESOLVED') throw new IncidentError('INVALID_TRANSITION', 'Resolved incidents cannot be edited');
      if (user.role === 'MAINTENANCE_ENGINEER' && incident.assignedToId !== user.id) throw new IncidentError('FORBIDDEN', 'Only the assigned engineer may add notes');
      return tx.incidentEvent.create({ data: { incidentId: id, actorId: user.id, kind: 'COMMENT', detail: input.data.message } });
    }, { maxWait: 15000, timeout: 30000 });
    service.notify();
    response.status(201).json({ data: event, simulated: true });
  });

  router.post('/incidents/:id/repairs', async (request, response) => {
    const id = String(request.params.id);
    const input = z.strictObject({ action: text, spareParts: z.array(z.string().trim().min(1).max(100)).max(20).default([]), cost: money }).safeParse(request.body);
    if (!uuid.safeParse(id).success || !input.success) { errorResponse(response, 'Invalid repair details'); return; }
    const user = response.locals.user as PublicUser;
    const repair = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Incident" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const incident = await tx.incident.findUnique({ where: { id }, select: { status: true, assignedToId: true } });
      if (!incident) throw new IncidentError('NOT_FOUND', 'Incident not found');
      if (!['UNDER_REPAIR', 'VERIFICATION'].includes(incident.status)) throw new IncidentError('INVALID_TRANSITION', 'Repair entries require Under Repair or Verification status');
      if (user.role === 'MAINTENANCE_ENGINEER' && incident.assignedToId !== user.id) throw new IncidentError('FORBIDDEN', 'Only the assigned engineer may record repairs');
      const created = await tx.repairRecord.create({ data: { incidentId: id, actorId: user.id, ...input.data } });
      await tx.incidentEvent.create({ data: { incidentId: id, actorId: user.id, kind: 'REPAIR', detail: input.data.action } });
      return created;
    }, { maxWait: 15000, timeout: 30000 });
    service.notify();
    response.status(201).json({ data: repair, simulated: true });
  });

  router.get('/maintenance', async (request, response) => {
    const input = z.object({ device: z.string().max(48).optional(), system: z.string().max(32).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), severity: z.enum(['WARNING', 'MAJOR', 'CRITICAL']).optional(), rootCause: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).safeParse(request.query);
    if (!input.success || (input.data.from && input.data.to && input.data.from > input.data.to)) { errorResponse(response, 'Invalid maintenance filters'); return; }
    const filter = input.data;
    const where = {
      device: filter.device || filter.system ? { code: filter.device || undefined, system: filter.system ? { code: filter.system } : undefined } : undefined,
      createdAt: filter.from || filter.to ? { gte: filter.from, lte: filter.to ? new Date(filter.to.getTime() + 86_400_000 - 1) : undefined } : undefined,
      alarm: filter.severity || filter.rootCause ? { level: filter.severity, diagnosis: filter.rootCause ? { confirmedRootCause: { contains: filter.rootCause, mode: 'insensitive' as const } } : undefined } : undefined,
    };
    const [total, incidents] = await Promise.all([
      db.incident.count({ where }),
      db.incident.findMany({ where, skip: (filter.page - 1) * filter.limit, take: filter.limit, orderBy: { createdAt: 'desc' }, include: { device: { select: { code: true, name: true, system: { select: { code: true } } } }, alarm: { select: { level: true, createdAt: true, resolvedAt: true, diagnosis: { select: { confirmedRootCause: true, component: true } } } }, assignedTo: { select: { name: true } }, _count: { select: { repairs: true, replacements: true } } } }),
    ]);
    response.json({ data: incidents, total, page: filter.page, limit: filter.limit, simulated: true });
  });

  router.get('/maintenance/:deviceCode', async (request, response) => {
    const device = await db.device.findUnique({ where: { code: String(request.params.deviceCode) }, select: { id: true, code: true, name: true, commissionedAt: true, system: { select: { id: true, code: true, name: true } } } });
    if (!device) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } }); return; }
    const incidents = await db.incident.findMany({ where: { deviceId: device.id }, orderBy: { createdAt: 'desc' }, take: 100,
      include: { alarm: { select: { level: true, createdAt: true, resolvedAt: true, diagnosis: { select: { confirmedRootCause: true, component: true } } } }, repairs: { include: { actor: { select: { name: true } } } }, assignedTo: { select: { name: true } } },
    });
    const [failureCount, repairCost, replacements, missingHeartbeats, outages] = await Promise.all([
      db.incident.count({ where: { deviceId: device.id } }),
      db.repairRecord.aggregate({ where: { incident: { deviceId: device.id } }, _sum: { cost: true } }),
      db.deviceReplacement.findMany({ where: { deviceId: device.id }, orderBy: { replacedAt: 'desc' }, include: { authorizedBy: { select: { name: true } } } }),
      db.faultDiagnosis.findMany({ where: { deviceId: device.id, ruleCode: 'MISSING_HEARTBEAT' }, select: { detectedAt: true, resolvedAt: true } }),
      db.alarm.findMany({ where: { sourceKey: { startsWith: 'outage:' }, device: { systemId: device.system.id } }, select: { createdAt: true, resolvedAt: true } }),
    ]);
    const now = new Date();
    response.json({ data: { device, incidents: incidents.map(incident => ({ ...incident, repairDurationMs: incident.repairStartedAt ? duration(incident.repairStartedAt, incident.repairCompletedAt, now) : null })),
      replacements, failureCount, recordedRepairCost: Number(repairCost._sum.cost ?? 0), replacementCost: replacements.reduce((sum, replacement) => sum + Number(replacement.cost), 0),
      equipmentDowntimeMs: missingHeartbeats.reduce((sum, fault) => sum + duration(fault.detectedAt, fault.resolvedAt, now), 0),
      serviceDowntimeMs: outages.reduce((sum, alarm) => sum + duration(alarm.createdAt, alarm.resolvedAt, now), 0),
    }, simulated: true });
  });

  router.post('/maintenance/:deviceCode/replacements', async (request, response) => {
    const user = response.locals.user as PublicUser;
    if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(user.role)) throw new IncidentError('FORBIDDEN', 'Supervisor authorization required');
    const input = z.strictObject({ oldUnitSerial: z.string().trim().min(1).max(100), newUnitSerial: z.string().trim().min(1).max(100), reason: text, cost: money, incidentId: uuid.optional() }).refine(value => value.oldUnitSerial !== value.newUnitSerial, 'Old and new unit must differ').safeParse(request.body);
    if (!input.success) { errorResponse(response, 'Invalid replacement details'); return; }
    const device = await db.device.findUnique({ where: { code: String(request.params.deviceCode) }, select: { id: true } });
    if (!device) throw new IncidentError('NOT_FOUND', 'Device not found');
    if (input.data.incidentId) {
      const incident = await db.incident.findUnique({ where: { id: input.data.incidentId }, select: { deviceId: true } });
      if (!incident || incident.deviceId !== device.id) { errorResponse(response, 'Incident must belong to this device'); return; }
    }
    try {
      const replacement = await db.$transaction(async tx => {
        const created = await tx.deviceReplacement.create({ data: { deviceId: device.id, authorizedById: user.id, ...input.data } });
        if (input.data.incidentId) await tx.incidentEvent.create({ data: { incidentId: input.data.incidentId, actorId: user.id, kind: 'REPLACEMENT', detail: `Unit ${input.data.oldUnitSerial} replaced with ${input.data.newUnitSerial}. ${input.data.reason}` } });
        return created;
      }, { maxWait: 15000, timeout: 30000 });
      service.notify();
      response.status(201).json({ data: replacement, simulated: true });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') { response.status(409).json({ error: { code: 'DUPLICATE_REPLACEMENT', message: 'This new unit is already recorded for the device' } }); return; }
      throw error;
    }
  });

  return router;
}
