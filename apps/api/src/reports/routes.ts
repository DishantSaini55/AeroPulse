import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';
import { toCsv, type ReportRow } from './csv.js';

const dayMs = 86_400_000;
const maxRows = 5000;
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filterSchema = z.strictObject({
  type: z.enum(['incidents', 'repairs', 'replacements', 'failovers', 'audit']),
  from: dateString, to: dateString,
  device: z.string().trim().min(1).max(48).optional(), system: z.string().trim().min(1).max(32).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
type Filters = z.infer<typeof filterSchema>;

function parseDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function validWindow(filter: Filters) {
  const from = parseDate(filter.from);
  const lastDay = parseDate(filter.to);
  if (!from || !lastDay || lastDay < from || lastDay.getTime() - from.getTime() > 365 * dayMs) return null;
  if (filter.type === 'audit' && (filter.device || filter.system)) return null;
  return { from, to: new Date(lastDay.getTime() + dayMs) };
}

const columns = {
  incidents: ['createdAtUTC', 'incidentId', 'device', 'system', 'severity', 'priority', 'status', 'rootCause', 'component', 'engineer', 'repairDurationMs', 'repairCostINR', 'spareParts', 'resolvedAtUTC'],
  repairs: ['createdAtUTC', 'repairId', 'incidentId', 'device', 'system', 'engineer', 'action', 'spareParts', 'costINR'],
  replacements: ['replacedAtUTC', 'replacementId', 'device', 'system', 'oldUnitSerial', 'newUnitSerial', 'reason', 'authorizedBy', 'costINR'],
  failovers: ['detectedAtUTC', 'eventId', 'system', 'action', 'result', 'fromDevice', 'toDevice', 'durationMs', 'reason'],
  audit: ['occurredAtUTC', 'eventId', 'actor', 'actorRole', 'method', 'path', 'statusCode'],
} as const;

async function rowsFor(db: Database, filter: Filters, from: Date, to: Date): Promise<ReportRow[]> {
  const date = { gte: from, lt: to };
  const device = filter.device || filter.system ? { code: filter.device, system: filter.system ? { code: filter.system } : undefined } : undefined;
  if (filter.type === 'incidents') {
    const items = await db.incident.findMany({ where: { createdAt: date, device }, take: maxRows + 1, orderBy: { createdAt: 'desc' }, include: {
      device: { select: { code: true, system: { select: { code: true } } } }, assignedTo: { select: { name: true } },
      alarm: { select: { level: true, diagnosis: { select: { confirmedRootCause: true, component: true } } } },
      repairs: { select: { cost: true, spareParts: true } },
    } });
    return items.map(item => ({ createdAtUTC: item.createdAt.toISOString(), incidentId: item.id, device: item.device.code, system: item.device.system.code,
      severity: item.alarm.level, priority: item.priority, status: item.status, rootCause: item.alarm.diagnosis?.confirmedRootCause ?? null,
      component: item.alarm.diagnosis?.component ?? null, engineer: item.assignedTo?.name ?? null,
      repairDurationMs: item.repairStartedAt && item.repairCompletedAt ? Math.max(0, item.repairCompletedAt.getTime() - item.repairStartedAt.getTime()) : null,
      repairCostINR: item.repairs.reduce((sum, repair) => sum + Number(repair.cost), 0),
      spareParts: [...new Set(item.repairs.flatMap(repair => repair.spareParts))].join('; '), resolvedAtUTC: item.resolvedAt?.toISOString() ?? null }));
  }
  if (filter.type === 'repairs') {
    const items = await db.repairRecord.findMany({ where: { createdAt: date, incident: device ? { device } : undefined }, take: maxRows + 1, orderBy: { createdAt: 'desc' }, include: {
      incident: { select: { id: true, device: { select: { code: true, system: { select: { code: true } } } } } }, actor: { select: { name: true } },
    } });
    return items.map(item => ({ createdAtUTC: item.createdAt.toISOString(), repairId: item.id, incidentId: item.incident.id, device: item.incident.device.code,
      system: item.incident.device.system.code, engineer: item.actor.name, action: item.action, spareParts: item.spareParts.join('; '), costINR: Number(item.cost) }));
  }
  if (filter.type === 'replacements') {
    const items = await db.deviceReplacement.findMany({ where: { replacedAt: date, device }, take: maxRows + 1, orderBy: { replacedAt: 'desc' }, include: {
      device: { select: { code: true, system: { select: { code: true } } } }, authorizedBy: { select: { name: true } },
    } });
    return items.map(item => ({ replacedAtUTC: item.replacedAt.toISOString(), replacementId: item.id, device: item.device.code, system: item.device.system.code,
      oldUnitSerial: item.oldUnitSerial, newUnitSerial: item.newUnitSerial, reason: item.reason, authorizedBy: item.authorizedBy.name, costINR: Number(item.cost) }));
  }
  if (filter.type === 'failovers') {
    const items = await db.failoverEvent.findMany({ where: { detectedAt: date, system: filter.system ? { code: filter.system } : undefined,
      OR: filter.device ? [{ fromDevice: { code: filter.device } }, { toDevice: { code: filter.device } }] : undefined },
      take: maxRows + 1, orderBy: { detectedAt: 'desc' }, include: { system: { select: { code: true } }, fromDevice: { select: { code: true } }, toDevice: { select: { code: true } } } });
    return items.map(item => ({ detectedAtUTC: item.detectedAt.toISOString(), eventId: item.id, system: item.system.code, action: item.action,
      result: item.result, fromDevice: item.fromDevice?.code ?? null, toDevice: item.toDevice?.code ?? null, durationMs: item.durationMs, reason: item.reason }));
  }
  const items = await db.auditEvent.findMany({ where: { occurredAt: date }, take: maxRows + 1, orderBy: { occurredAt: 'desc' }, include: { actor: { select: { name: true } } } });
  return items.map(item => ({ occurredAtUTC: item.occurredAt.toISOString(), eventId: item.id, actor: item.actor.name, actorRole: item.actorRole,
    method: item.method, path: item.path, statusCode: item.statusCode }));
}

export function reportRoutes(db: Database) {
  const router = Router();
  router.get('/audit-events', async (request, response) => {
    const user = response.locals.user as PublicUser;
    if (!['SUPERVISOR', 'ADMINISTRATOR'].includes(user.role)) { response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Supervisor access required' } }); return; }
    const input = z.strictObject({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30),
      from: dateString.optional(), to: dateString.optional(), outcome: z.enum(['all', 'success', 'failure']).default('all') }).safeParse(request.query);
    const from = input.success && input.data.from ? parseDate(input.data.from) : null;
    const lastDay = input.success && input.data.to ? parseDate(input.data.to) : null;
    if (!input.success || (input.data.from && !from) || (input.data.to && !lastDay) || (from && lastDay && lastDay < from)) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid audit filters' } }); return;
    }
    const filter = input.data;
    const where = { occurredAt: from || lastDay ? { gte: from ?? undefined, lt: lastDay ? new Date(lastDay.getTime() + dayMs) : undefined } : undefined,
      statusCode: filter.outcome === 'success' ? { lt: 400 } : filter.outcome === 'failure' ? { gte: 400 } : undefined };
    const [total, rows] = await Promise.all([
      db.auditEvent.count({ where }),
      db.auditEvent.findMany({ where, skip: (filter.page - 1) * filter.limit, take: filter.limit, orderBy: { occurredAt: 'desc' },
        include: { actor: { select: { name: true, email: true } } } }),
    ]);
    response.setHeader('Cache-Control', 'no-store');
    response.json({ data: rows, total, page: filter.page, limit: filter.limit,
      note: 'Authenticated mutation attempts are recorded after the HTTP response. Writes are best effort and are not transactionally coupled to the action.' });
  });

  router.get('/reports', async (request, response) => {
    const user = response.locals.user as PublicUser;
    if (!['SUPERVISOR', 'ADMINISTRATOR'].includes(user.role)) { response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Supervisor access required' } }); return; }
    const parsed = filterSchema.safeParse(request.query);
    const window = parsed.success ? validWindow(parsed.data) : null;
    if (!parsed.success || !window) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose a report, valid UTC dates within 365 days, and compatible filters' } }); return; }
    const filter = parsed.data;
    const start = performance.now();
    const rows = await rowsFor(db, filter, window.from, window.to);
    if (rows.length > maxRows) { response.status(413).json({ error: { code: 'REPORT_TOO_LARGE', message: 'More than 5000 rows. Narrow the UTC date window or filters.' } }); return; }
    const queryMs = Math.round(performance.now() - start);
    response.setHeader('Cache-Control', 'no-store');
    if (filter.format === 'csv') {
      response.type('text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', `attachment; filename="aeropulse-${filter.type}-${filter.from}-to-${filter.to}.csv"`);
      response.send(toCsv(columns[filter.type], rows));
      return;
    }
    response.json({ type: filter.type, columns: columns[filter.type], rows, total: rows.length, queryMs, generatedAt: new Date().toISOString(),
      from: filter.from, to: filter.to, simulated: true, note: 'Recorded simulation data; report dates and timestamps use UTC.' });
  });
  return router;
}
