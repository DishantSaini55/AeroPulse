import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import type { Database } from './db.js';
import type { WeatherService } from './weather/service.js';
import { normalizeEmail, passwordSchema, type AuthProvider, type PublicUser } from './auth.js';
import type { UserRole } from './generated/prisma/enums.js';
import { heartbeatPolicyFromEnv, type HeartbeatPolicy } from './heartbeat/monitor.js';
import { FailbackError, RedundancyManager } from './failover/manager.js';
import type { TelemetrySimulator } from './simulator/service.js';
import { diagnosticThresholds } from './diagnostics/rules.js';
import type { Scenario } from './simulator/generator.js';
import { escalationDelay } from './alarms/service.js';
import { IncidentError, IncidentService } from './incidents/service.js';
import { incidentRoutes } from './incidents/routes.js';
import { calculateReliability } from './analytics/metrics.js';
import { historicalDemoInput, recordedAnalyticsInput } from './analytics/source.js';
import { recommendationRoutes } from './recommendations/routes.js';
import { auditMutations } from './reports/audit.js';
import { reportRoutes } from './reports/routes.js';
import { documentRoutes } from './reports/document-routes.js';
import { requestLogger, securityHeaders } from './observability.js';
import { MaintenanceError, MaintenanceService } from './maintenance/service.js';
import { maintenanceWorkspaceRoutes, workOrderCosts } from './maintenance/workspace.js';
import { maintenanceAnnouncementRoutes, recordUnsafeStart } from './maintenance/announcements.js';
import { notificationRoutes } from './notifications/routes.js';
import { recordNotification } from './notifications/service.js';

const noteInput = z.strictObject({
  systemName: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(1000),
});

type Note = z.infer<typeof noteInput> & { id: string; createdAt: string };

// Operations notes are deliberately temporary and scoped to one API process.
const roleSchema = z.enum(['ADMINISTRATOR', 'SUPERVISOR', 'MAINTENANCE_ENGINEER']);
const userInput = z.strictObject({
  email: z.email().max(254),
  name: z.string().trim().min(2).max(120),
  password: passwordSchema,
  role: roleSchema,
});
const userUpdate = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  role: roleSchema.optional(),
  active: z.boolean().optional(),
}).refine(value => Object.keys(value).length > 0, 'At least one field is required');

export type RuntimeStatus = { redis?: 'ready' | 'degraded'; leader?: boolean; backgroundJobs?: boolean };

export function createApp(db?: Database, weather?: WeatherService, auth?: AuthProvider, disconnectUser?: (id: string) => void, heartbeatPolicy: HeartbeatPolicy = heartbeatPolicyFromEnv(), redundancy?: RedundancyManager, simulator?: TelemetrySimulator, incidents?: IncidentService, simulationControlAvailable: () => boolean = () => true, runtimeStatus?: () => RuntimeStatus, onMaintenanceChange?: () => void) {
  const app = express();
  const notes = new Map<string, Note>();
  const analyticsCache = new Map<string, { until: number; value: unknown }>();
  const maintenance = db ? new MaintenanceService(db) : undefined;
  const maintenanceRedundancy = redundancy ?? (db ? new RedundancyManager(db, heartbeatPolicy) : undefined);

  app.disable('x-powered-by');
  // Trust only an explicitly configured proxy hop count. Never accept arbitrary
  // client-supplied X-Forwarded-For values in a direct/local deployment.
  const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 3) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 3');
  if (trustedProxyHops > 0) app.set('trust proxy', trustedProxyHops);
  app.use(securityHeaders());
  app.use(requestLogger());
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/v1/health', (_request, response) => {
    const runtime = runtimeStatus?.();
    response.json({ status: runtime?.redis === 'degraded' ? 'degraded' : 'ok', service: 'aeropulse-api', instanceId: process.env.INSTANCE_ID ?? 'local', ...(runtime ? { runtime } : {}) });
  });

  app.get('/api/v1/ready', async (_request, response) => {
    try {
      if (!db) throw new Error('Database unavailable');
      await db.$queryRawUnsafe('SELECT 1');
      response.json({ status: 'ready', ...(runtimeStatus ? { runtime: runtimeStatus() } : {}) });
    } catch {
      response.status(503).json({ status: 'not_ready', error: { code: 'DATABASE_UNAVAILABLE', message: 'Database readiness check failed' } });
    }
  });

  app.post('/api/v1/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), async (request, response) => {
    if (!auth) {
      response.status(503).json({ error: { code: 'AUTH_UNAVAILABLE', message: 'Authentication is not configured' } });
      return;
    }
    const input = z.strictObject({ email: z.email(), password: z.string() }).safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid email and password are required' } });
      return;
    }
    const result = await auth.login(input.data.email, input.data.password);
    if (!result) {
      response.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.json(result);
  });

  const requireAuth: RequestHandler = async (request, response, next) => {
    if (!auth) {
      response.status(503).json({ error: { code: 'AUTH_UNAVAILABLE', message: 'Authentication is not configured' } });
      return;
    }
    const match = /^Bearer (\S+)$/i.exec(request.get('authorization') ?? '');
    const user = match ? await auth.verifyToken(match[1]!) : null;
    if (!user) {
      response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }
    response.locals.user = user;
    next();
  };
  app.use('/api/v1', requireAuth);
  app.use('/api/v1', rateLimit({ windowMs: 15 * 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false,
    skip: request => !['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) }));
  if (db) app.use('/api/v1', auditMutations(db));

  const requireRole = (...roles: UserRole[]): RequestHandler => (_request, response, next) => {
    const user = response.locals.user as PublicUser;
    if (!roles.includes(user.role)) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
      return;
    }
    next();
  };

  if (db) app.use('/api/v1/maintenance', (request, response, next) => { if (['POST','PATCH','DELETE'].includes(request.method)) response.once('finish', () => { if (response.statusCode < 300 || response.locals.maintenanceNoticeRecorded) onMaintenanceChange?.(); }); next(); }, maintenanceAnnouncementRoutes(db), maintenanceWorkspaceRoutes(db, heartbeatPolicy));
  const maintenancePlanInput = z.strictObject({ name: z.string().trim().min(3).max(140), deviceId: z.uuid(), category: z.string().trim().min(3).max(100), description: z.string().trim().min(3).max(2000), checklist: z.array(z.string().trim().min(1).max(500)).min(1).max(30), frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'CUSTOM']), customIntervalDays: z.number().int().min(1).max(3650).optional(), advanceNoticeDays: z.number().int().min(0).max(365).default(7), estimatedDurationMinutes: z.number().int().min(1).max(10080), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'), assignedEngineerId: z.uuid().optional() }).refine(value => value.frequency !== 'CUSTOM' || value.customIntervalDays, 'Custom frequency requires customIntervalDays');
  app.get('/api/v1/maintenance/plans', async (_request, response) => { if (!db) throw new Error('Database unavailable'); response.json({ data: await db.maintenancePlan.findMany({ orderBy: { nextScheduledAt: 'asc' }, include: { device: { select: { code: true, name: true } }, assignedEngineer: { select: { name: true } } } }), simulated: true }); });
  app.post('/api/v1/maintenance/plans', requireRole('ADMINISTRATOR', 'SUPERVISOR'), async (request, response) => { const parsed = maintenancePlanInput.safeParse(request.body); if (!parsed.success || !maintenance) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid maintenance plan' } }); return; } try { response.status(201).json({ data: await maintenance.createPlan(parsed.data, (response.locals.user as PublicUser).id), simulated: true }); } catch (error) { if (error instanceof MaintenanceError) { response.status(409).json({ error: { code: error.code, message: error.message } }); return; } throw error; } });
  app.get('/api/v1/maintenance/work-orders', async (_request, response) => { if (!db) throw new Error('Database unavailable'); response.json({ data: await db.maintenanceWorkOrder.findMany({ orderBy: { createdAt: 'desc' }, include: { device: { select: { code: true, name: true } }, assignedEngineer: { select: { name: true } } } }), simulated: true }); });
  app.get('/api/v1/maintenance/plans/:id', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid plan ID' } }); return; } const plan = await db.maintenancePlan.findUnique({ where: { id: String(request.params.id) }, include: { workOrders: { orderBy: { createdAt: 'desc' }, take: 30 } } }); if (!plan) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } }); return; } response.json({ data: plan, simulated: true }); });
  app.patch('/api/v1/maintenance/plans/:id', requireRole('ADMINISTRATOR', 'SUPERVISOR'), async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid plan ID' } }); return; } const parsed = z.strictObject(maintenancePlanInput.shape).partial().extend({ active: z.boolean().optional(), assignedEngineerId: z.uuid().nullable().optional() }).safeParse(request.body); if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid maintenance plan update' } }); return; } const plan = await maintenance!.updatePlan(String(request.params.id), Object.fromEntries(Object.entries(parsed.data).filter(([key]) => Object.hasOwn(request.body, key))) as typeof parsed.data, (response.locals.user as PublicUser).id); if (!plan) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } }); return; } response.json({ data: plan, simulated: true }); });
  app.get('/api/v1/maintenance/work-orders/:id', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order ID' } }); return; } const order = await db.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) }, include: { checklistItems: { orderBy: { id: 'asc' } }, parts: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, transitions: { orderBy: { createdAt: 'asc' } } } }); if (!order) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Work order not found' } }); return; } response.json({ data: order, simulated: true }); });
  const partInput = z.strictObject({ partName: z.string().trim().min(1).max(200), partNumber: z.string().trim().max(100).optional(), quantity: z.number().int().min(1).max(10000), unitCost: z.number().min(0).max(10_000_000).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, 'Use two decimal places') });
  app.post('/api/v1/maintenance/work-orders/:id/parts', async (request, response) => { const parsed = partInput.safeParse(request.body); if (!parsed.success || !maintenance || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid part record' } }); return; } try { response.status(201).json({ data: await maintenance.addPart(String(request.params.id), parsed.data, response.locals.user as PublicUser), simulated: true }); } catch (error) { if (error instanceof MaintenanceError) { response.status(409).json({ error: { code: error.code, message: error.message } }); return; } throw error; } });
  app.get('/api/v1/maintenance/work-orders/:id/costs', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order ID' } }); return; } const order = await db.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) }, include: { parts: true } }); if (!order) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Work order not found' } }); return; } response.json({ data: workOrderCosts(order), simulated: true }); });
  const manualOrder = z.strictObject({ title: z.string().trim().min(3).max(200), deviceId: z.uuid(), type: z.enum(['CORRECTIVE', 'INSPECTION', 'COMPONENT_REPLACEMENT', 'EQUIPMENT_REPLACEMENT']), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']), description: z.string().trim().min(3).max(2000), estimatedDurationMinutes: z.number().int().min(1).max(10080), scheduledStartAt: z.coerce.date().optional() });
  app.post('/api/v1/maintenance/work-orders', requireRole('ADMINISTRATOR', 'SUPERVISOR'), async (request, response) => { if (!db) throw new Error('Database unavailable'); const parsed = manualOrder.safeParse(request.body); if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } const device = await db.device.findUnique({ where: { id: parsed.data.deviceId }, select: { systemId: true } }); if (!device) { response.status(404).json({ error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' } }); return; } const actor = response.locals.user as PublicUser; const scheduled = parsed.data.scheduledStartAt; const data = await db.maintenanceWorkOrder.create({ data: { occurrenceKey: `manual:${randomUUID()}`, title: parsed.data.title, deviceId: parsed.data.deviceId, systemId: device.systemId, type: parsed.data.type, priority: parsed.data.priority, description: parsed.data.description, status: scheduled ? 'SCHEDULED' : 'DRAFT', supervisorId: actor.id, scheduledStartAt: scheduled, estimatedDurationMinutes: parsed.data.estimatedDurationMinutes, transitions: { create: { toStatus: scheduled ? 'SCHEDULED' : 'DRAFT', actorId: actor.id, note: 'Manual simulated work order created' } } } }); response.status(201).json({ data, simulated: true }); });
  app.post('/api/v1/maintenance/work-orders/:id/assign', requireRole('ADMINISTRATOR', 'SUPERVISOR'), async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } const parsed = z.strictObject({ engineerId: z.uuid() }).safeParse(request.body); if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid engineer required' } }); return; } const engineer = await db.user.findUnique({ where: { id: parsed.data.engineerId }, select: { active: true, role: true } }); if (!engineer || !engineer.active || engineer.role !== 'MAINTENANCE_ENGINEER') { response.status(409).json({ error: { code: 'INVALID_ENGINEER', message: 'Choose an active maintenance engineer' } }); return; } const actor = response.locals.user as PublicUser; const order = await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${String(request.params.id)}::uuid FOR UPDATE`; const current = await tx.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) } }); if (!current) return null; if (!['DRAFT', 'SCHEDULED'].includes(current.status)) throw new MaintenanceError('INVALID_TRANSITION', 'Only draft or scheduled work may be assigned'); const updated = await tx.maintenanceWorkOrder.update({ where: { id: current.id }, data: { assignedEngineerId: engineer ? parsed.data.engineerId : undefined, status: 'ASSIGNED' } }); const history = await tx.workOrderStatusHistory.create({ data: { workOrderId: current.id, fromStatus: current.status, toStatus: 'ASSIGNED', actorId: actor.id, note: 'Engineer assigned' } }); await recordNotification(tx, { sourceKey: `maintenance:history:${history.id}`, kind: 'MAINTENANCE_ASSIGNED', priority: current.priority === 'URGENT' ? 'CRITICAL' : 'WARNING', title: 'Maintenance assigned', body: current.title, deviceId: current.deviceId, userIds: [parsed.data.engineerId] }); return updated; }); if (!order) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Work order not found' } }); return; } response.json({ data: order, simulated: true }); });
  app.post('/api/v1/maintenance/work-orders/:id/cancel', requireRole('ADMINISTRATOR', 'SUPERVISOR'), async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } const parsed = z.strictObject({ reason: z.string().trim().min(3).max(1000) }).safeParse(request.body); if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Cancellation reason required' } }); return; } const actor = response.locals.user as PublicUser; const order = await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${String(request.params.id)}::uuid FOR UPDATE`; const current = await tx.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) } }); if (!current) return null; if (current.maintenanceModeAt || ['COMPLETED', 'CANCELLED'].includes(current.status)) throw new MaintenanceError('INVALID_TRANSITION', 'Finalized work order cannot be cancelled'); const updated = await tx.maintenanceWorkOrder.update({ where: { id: current.id }, data: { status: 'CANCELLED', cancellationReason: parsed.data.reason } }); await tx.workOrderStatusHistory.create({ data: { workOrderId: current.id, fromStatus: current.status, toStatus: 'CANCELLED', actorId: actor.id, note: parsed.data.reason } }); return updated; }); if (!order) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Work order not found' } }); return; } response.json({ data: order, simulated: true }); });
  app.get('/api/v1/maintenance/work-orders/:id/history', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } response.json({ data: await db.workOrderStatusHistory.findMany({ where: { workOrderId: String(request.params.id) }, orderBy: { createdAt: 'asc' }, include: { actor: { select: { name: true, role: true } } } }), simulated: true }); });
  const checklistInput = z.strictObject({ result: z.enum(['PASSED', 'FAILED', 'NOT_APPLICABLE']), remarks: z.string().trim().max(2000).optional() });
  app.get('/api/v1/maintenance/work-orders/:id/checklist', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } response.json({ data: await db.workOrderChecklistItem.findMany({ where: { workOrderId: String(request.params.id) }, orderBy: { id: 'asc' }, include: { completedBy: { select: { name: true } } } }), simulated: true }); });
  app.patch('/api/v1/maintenance/work-orders/:id/checklist/:itemId', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success || !z.uuid().safeParse(request.params.itemId).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid checklist reference' } }); return; } const parsed = checklistInput.safeParse(request.body); if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid checklist result' } }); return; } const actor = response.locals.user as PublicUser; const item = await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${String(request.params.id)}::uuid FOR UPDATE`; const order = await tx.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) }, select: { status: true, assignedEngineerId: true } }); if (!order) return null; if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new MaintenanceError('COMPLETED', 'Completed work order is immutable'); if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role) && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only assigned engineer may complete checklist'); return tx.workOrderChecklistItem.update({ where: { id: String(request.params.itemId), workOrderId: String(request.params.id) }, data: { completed: true, result: parsed.data.result, remarks: parsed.data.remarks, completedAt: new Date(), completedById: actor.id } }); }).catch(error => { if ((error as { code?: string }).code === 'P2025') return undefined; throw error; }); if (!item) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Checklist item not found for work order' } }); return; } response.json({ data: item, simulated: true }); });
  app.patch('/api/v1/maintenance/work-orders/:id/findings', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } const parsed = z.strictObject({ findings: z.string().trim().min(3).max(4000) }).safeParse(request.body); if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Findings required' } }); return; } const actor = response.locals.user as PublicUser; const updated = await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${String(request.params.id)}::uuid FOR UPDATE`; const order = await tx.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) } }); if (!order) return null; if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new MaintenanceError('FINALIZED', 'Finalized work order is immutable'); if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role) && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only assigned engineer may update findings'); return tx.maintenanceWorkOrder.update({ where: { id: order.id }, data: parsed.data }); }); if (!updated) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Work order not found' } }); return; } response.json({ data: updated, simulated: true }); });
  app.get('/api/v1/maintenance/work-orders/:id/parts', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } response.json({ data: await db.workOrderPartUsage.findMany({ where: { workOrderId: String(request.params.id) }, orderBy: { createdAt: 'asc' } }), simulated: true }); });
  app.patch('/api/v1/maintenance/work-orders/:id/parts/:partId', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success || !z.uuid().safeParse(request.params.partId).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid part reference' } }); return; } const parsed = partInput.safeParse(request.body); if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid part record' } }); return; } const actor = response.locals.user as PublicUser; const part = await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${String(request.params.id)}::uuid FOR UPDATE`; const order = await tx.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) }, select: { status: true, assignedEngineerId: true } }); if (!order) return null; if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new MaintenanceError('FINALIZED', 'Finalized work orders are immutable'); if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role) && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only assigned engineer may update parts'); const result = await tx.workOrderPartUsage.updateMany({ where: { id: String(request.params.partId), workOrderId: String(request.params.id) }, data: parsed.data }); return result.count ? tx.workOrderPartUsage.findUnique({ where: { id: String(request.params.partId) } }) : undefined; }); if (!part) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Part not found for work order' } }); return; } response.json({ data: part, simulated: true }); });
  app.delete('/api/v1/maintenance/work-orders/:id/parts/:partId', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success || !z.uuid().safeParse(request.params.partId).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid part reference' } }); return; } const actor = response.locals.user as PublicUser; const deleted = await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${String(request.params.id)}::uuid FOR UPDATE`; const order = await tx.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) }, select: { status: true, assignedEngineerId: true } }); if (!order) return null; if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new MaintenanceError('FINALIZED', 'Finalized work orders are immutable'); if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role) && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only assigned engineer may delete parts'); return tx.workOrderPartUsage.deleteMany({ where: { id: String(request.params.partId), workOrderId: String(request.params.id) } }); }); if (!deleted?.count) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Part not found for work order' } }); return; } response.status(204).end(); });
  app.post('/api/v1/maintenance/work-orders/:id/start', async (request, response) => {
    if (!db || !maintenanceRedundancy || !z.uuid().safeParse(request.params.id).success || !z.strictObject({}).safeParse(request.body ?? {}).success) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid maintenance start' } }); return;
    }
    const actor = response.locals.user as PublicUser, id = String(request.params.id);
    try { response.json({ data: await maintenanceRedundancy.startMaintenance(id, actor), simulated: true }); }
    catch (error) { response.locals.maintenanceNoticeRecorded = await recordUnsafeStart(db, id, actor, error); throw error; }
  });
  const verificationInput = z.strictObject({ passed: z.boolean(), remarks: z.string().trim().min(3).max(4000) });
  app.post('/api/v1/maintenance/work-orders/:id/verify', async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } const parsed = verificationInput.safeParse(request.body); if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Verification result required' } }); return; } const actor = response.locals.user as PublicUser; const result = await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${String(request.params.id)}::uuid FOR UPDATE`; const order = await tx.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) }, include: { checklistItems: true } }); if (!order) return null; if (!['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(order.status)) throw new MaintenanceError('INVALID_TRANSITION', 'Work order is not awaiting verification'); if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role) && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only assigned engineer may verify'); if (parsed.data.passed && order.checklistItems.some(item => !item.completed || !item.result || item.result === 'FAILED')) throw new MaintenanceError('CHECKLIST_INCOMPLETE', 'All checklist items must be completed without failed results'); const next = parsed.data.passed ? 'VERIFICATION' : 'ON_HOLD'; const updated = await tx.maintenanceWorkOrder.update({ where: { id: order.id }, data: { status: next, verificationResult: parsed.data.remarks } }); await tx.workOrderStatusHistory.create({ data: { workOrderId: order.id, fromStatus: order.status, toStatus: next, actorId: actor.id, note: `${parsed.data.passed ? "Verification passed" : "Verification failed"}: ${parsed.data.remarks}`.slice(0,2000) } }); return updated; }); if (!result) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Work order not found' } }); return; } response.json({ data: result, simulated: true, note: 'Verification records simulated evidence only; successful verification requires supervisor approval before standby eligibility restoration.' }); });
  app.post('/api/v1/maintenance/work-orders/:id/approve', requireRole('ADMINISTRATOR', 'SUPERVISOR'), async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } const actor = response.locals.user as PublicUser; const preview = await db.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) } }); if (preview?.maintenanceModeAt && maintenanceRedundancy) { response.json({ data: await maintenanceRedundancy.approveMaintenance(preview.id, actor), simulated: true }); return; } const updated = await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${String(request.params.id)}::uuid FOR UPDATE`; const order = await tx.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) } }); if (!order) return null; if (order.status !== 'VERIFICATION') throw new MaintenanceError('INVALID_TRANSITION', 'Supervisor approval requires verification state'); const value = await tx.maintenanceWorkOrder.update({ where: { id: order.id }, data: { status: 'ON_HOLD' } }); await tx.workOrderStatusHistory.create({ data: { workOrderId: order.id, fromStatus: order.status, toStatus: 'ON_HOLD', actorId: actor.id, note: 'Approved verification; activation-sensitive completion blocked pending Prompt 4C' } }); return value; }); if (!updated) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Work order not found' } }); return; } response.status(409).json({ data: updated, error: { code: 'ACTIVATION_SAFETY_PENDING', message: 'Approval recorded, but completion is blocked until Prompt 4C redundancy safety.' } }); });
  app.post('/api/v1/maintenance/work-orders/:id/reject', requireRole('ADMINISTRATOR', 'SUPERVISOR'), async (request, response) => { if (!db || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid work order' } }); return; } const parsed = z.strictObject({ reason: z.string().trim().min(3).max(2000) }).safeParse(request.body); if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Rejection reason required' } }); return; } const actor = response.locals.user as PublicUser; const updated = await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${String(request.params.id)}::uuid FOR UPDATE`; const order = await tx.maintenanceWorkOrder.findUnique({ where: { id: String(request.params.id) } }); if (!order) return null; if (order.status !== 'VERIFICATION') throw new MaintenanceError('INVALID_TRANSITION', 'Rejection requires verification state'); const nextStatus = order.maintenanceModeAt ? 'ON_HOLD' : 'REJECTED'; return tx.maintenanceWorkOrder.update({ where: { id: order.id }, data: { status: nextStatus, cancellationReason: parsed.data.reason, transitions: { create: { fromStatus: order.status, toStatus: nextStatus, actorId: actor.id, note: parsed.data.reason } } } }); }); if (!updated) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Work order not found' } }); return; } response.json({ data: updated, simulated: true }); });

  app.get('/api/v1/auth/me', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ user: response.locals.user as PublicUser });
  });

  app.get('/api/v1/users', requireRole('ADMINISTRATOR'), async (_request, response) => {
    if (!db) throw new Error('Database unavailable');
    const users = await db.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, email: true, name: true, role: true, active: true, createdAt: true } });
    response.json({ data: users });
  });

  app.post('/api/v1/users', requireRole('ADMINISTRATOR'), async (request, response) => {
    if (!db) throw new Error('Database unavailable');
    const parsed = userInput.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid user details', details: parsed.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })) } });
      return;
    }
    const bcrypt = await import('bcrypt');
    try {
      const user = await db.user.create({
        data: {
          email: normalizeEmail(parsed.data.email), name: parsed.data.name, role: parsed.data.role,
          passwordHash: await bcrypt.default.hash(parsed.data.password, 12),
        },
        select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
      });
      response.status(201).json({ data: user });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        response.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'Email already exists' } });
        return;
      }
      throw error;
    }
  });

  app.patch('/api/v1/users/:id', requireRole('ADMINISTRATOR'), async (request, response) => {
    if (!db) throw new Error('Database unavailable');
    const parsed = userUpdate.safeParse(request.body);
    if (!parsed.success || !z.uuid().safeParse(request.params.id).success) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid user update' } });
      return;
    }
    const id = String(request.params.id);
    const current = response.locals.user as PublicUser;
    if (id === current.id && (parsed.data.role && parsed.data.role !== current.role || parsed.data.active === false)) {
      response.status(409).json({ error: { code: 'SELF_CHANGE_RESTRICTED', message: 'Cannot change your own role or disable your account' } });
      return;
    }
    const existing = await db.user.findUnique({ where: { id } });
    if (!existing) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }
    const user = await db.user.update({ where: { id }, data: parsed.data, select: { id: true, email: true, name: true, role: true, active: true, createdAt: true } });
    if (!user.active) disconnectUser?.(id);
    response.json({ data: user });
  });

  app.get('/api/v1/weather/vidp', async (_request, response) => {
    if (!weather) {
      response.status(503).json({ error: { code: 'WEATHER_UNAVAILABLE', message: 'Weather service not configured' } });
      return;
    }
    const result = await weather.getCurrent();
    response.status(result.data ? 200 : 503).json(result);
  });

  app.get('/api/v1/systems', async (_request, response) => {
    if (!db) {
      response.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database not configured' } });
      return;
    }
    const systems = await db.logicalSystem.findMany({
      orderBy: { code: 'asc' },
      include: { devices: { orderBy: { role: 'asc' } } },
    });
    response.json({ data: systems, simulated: true });
  });

  app.get('/api/v1/systems/:code', async (request, response) => {
    if (!db) {
      response.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database not configured' } });
      return;
    }
    const system = await db.logicalSystem.findUnique({
      where: { code: String(request.params.code).toUpperCase() },
      include: { devices: { orderBy: { role: 'asc' } } },
    });
    if (!system) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'System not found' } });
      return;
    }
    response.json({ data: system, simulated: true });
  });

  app.get('/api/v1/redundancy', async (_request, response) => {
    if (!db) {
      response.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database not configured' } });
      return;
    }
    const systems = await db.logicalSystem.findMany({
      orderBy: { code: 'asc' },
      include: {
        devices: { orderBy: { role: 'asc' }, include: { heartbeats: { take: 1, orderBy: { recordedAt: 'desc' } } } },
        failoverEvents: { take: 1, orderBy: { detectedAt: 'desc' }, select: { id: true, action: true, result: true, detectedAt: true, durationMs: true, reason: true } },
      },
    });
    response.json({
      recordedAt: new Date().toISOString(), simulated: true, policy: heartbeatPolicy,
      data: systems.map(system => {
        const devices = system.devices.map(({ heartbeats, ...device }) => ({
          id: device.id, code: device.code, name: device.name, role: device.role,
          health: device.health, activationState: device.activationState,
          maintenanceStatus: device.maintenanceStatus, maintenanceEligible: device.maintenanceEligible,
          latestHeartbeatAt: heartbeats[0]?.recordedAt ?? null,
          heartbeatPaused: simulator?.isHeartbeatPaused(device.code) ?? false,
        }));
        return {
          id: system.id, code: system.code, name: system.name, availability: system.availability,
          activeDeviceCode: devices.find(device => device.activationState === 'ACTIVE')?.code ?? null,
          standbyReady: devices.some(device => device.activationState === 'STANDBY' && device.health === 'HEALTHY' && device.maintenanceEligible && device.maintenanceStatus === 'AVAILABLE' && device.latestHeartbeatAt && Date.now() - device.latestHeartbeatAt.getTime() >= 0 && Date.now() - device.latestHeartbeatAt.getTime() < heartbeatPolicy.timeoutMs),
          lastFailover: system.failoverEvents[0] ?? null,
          devices,
        };
      }),
    });
  });

  app.get('/api/v1/failover-events', async (request, response) => {
    if (!db) throw new Error('Database unavailable');
    const parsed = z.coerce.number().int().min(1).max(100).default(30).safeParse(request.query.limit);
    if (!parsed.success) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid limit' } });
      return;
    }
    const events = await db.failoverEvent.findMany({
      take: parsed.data, orderBy: { detectedAt: 'desc' },
      include: { system: { select: { code: true, name: true } }, fromDevice: { select: { code: true } }, toDevice: { select: { code: true } }, initiatedBy: { select: { name: true } } },
    });
    response.json({ data: events, simulated: true });
  });

  app.post('/api/v1/systems/:code/failback', requireRole('ADMINISTRATOR', 'SUPERVISOR'), async (request, response) => {
    if (!redundancy) {
      response.status(503).json({ error: { code: 'REDUNDANCY_UNAVAILABLE', message: 'Redundancy manager is unavailable' } });
      return;
    }
    try {
      const event = await redundancy.failback(String(request.params.code).toUpperCase(), (response.locals.user as PublicUser).id);
      response.json({ data: event, simulated: true });
    } catch (error) {
      if (!(error instanceof FailbackError)) throw error;
      response.status(error.code === 'NOT_FOUND' ? 404 : 409).json({ error: { code: error.code, message: error.message } });
    }
  });

  app.post('/api/v1/simulation/devices/:code/heartbeat', requireRole('ADMINISTRATOR'), async (request, response) => {
    if (!db || !simulator) {
      response.status(503).json({ error: { code: 'SIMULATOR_UNAVAILABLE', message: 'Simulator is unavailable' } });
      return;
    }
    const parsed = z.strictObject({ paused: z.boolean() }).safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Expected paused boolean' } });
      return;
    }
    const code = String(request.params.code).toUpperCase();
    const device = await db.device.findUnique({ where: { code }, select: { id: true } });
    if (!device) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
      return;
    }
    if (!simulationControlAvailable()) { response.status(503).json({ error: { code: 'DISTRIBUTED_CONTROL_UNAVAILABLE', message: 'Redis coordination is reconnecting; retry the simulation control request' } }); return; }
    try { await simulator.setHeartbeatPaused(code, parsed.data.paused); }
    catch { response.status(503).json({ error: { code: 'DISTRIBUTED_CONTROL_UNAVAILABLE', message: 'Simulation control could not be synchronized' } }); return; }
    response.json({ data: { code, heartbeatPaused: parsed.data.paused }, simulated: true });
  });

  app.get('/api/v1/simulation/devices', requireRole('ADMINISTRATOR'), async (_request, response) => {
    if (!db || !simulator) { response.status(503).json({ error: { code: 'SIMULATOR_UNAVAILABLE' } }); return; }
    const devices = await db.device.findMany({ orderBy: { code: 'asc' }, select: { code: true, name: true, role: true, system: { select: { code: true, name: true } } } });
    response.json({ data: devices.map(device => ({ ...device, scenario: simulator.getScenario(device.code), heartbeatPaused: simulator.isHeartbeatPaused(device.code) })), simulated: true });
  });

  app.post('/api/v1/simulation/devices/:code/scenario', requireRole('ADMINISTRATOR'), async (request, response) => {
    if (!db || !simulator) { response.status(503).json({ error: { code: 'SIMULATOR_UNAVAILABLE' } }); return; }
    const scenario = z.enum(['NORMAL', 'DEGRADATION', 'FAILURE', 'RECOVERY', 'OVERHEATING', 'FAN_FAILURE', 'CPU_OVERLOAD', 'MEMORY_OVERLOAD', 'DISK_EXHAUSTION', 'NETWORK_DISCONNECTION', 'PACKET_LOSS', 'POWER_FAILURE', 'MISSING_HEARTBEAT']).safeParse(request.body?.scenario);
    if (!scenario.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid scenario' } }); return; }
    const code = String(request.params.code).toUpperCase();
    const device = await db.device.findUnique({ where: { code }, select: { id: true, system: { select: { code: true } } } });
    if (!device) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } }); return; }
    const compute = ['AMSS', 'AUTOMATION', 'ASMGCS'].includes(device.system.code);
    const network = !['UPS', 'COOLING'].includes(device.system.code);
    if ((['CPU_OVERLOAD', 'MEMORY_OVERLOAD', 'DISK_EXHAUSTION'].includes(scenario.data) && !compute) || (['PACKET_LOSS', 'NETWORK_DISCONNECTION'].includes(scenario.data) && !network) || (scenario.data === 'POWER_FAILURE' && device.system.code !== 'UPS')) {
      response.status(409).json({ error: { code: 'SCENARIO_NOT_SUPPORTED', message: 'This scenario is not supported by this device type' } }); return;
    }
    if (!simulationControlAvailable()) { response.status(503).json({ error: { code: 'DISTRIBUTED_CONTROL_UNAVAILABLE', message: 'Redis coordination is reconnecting; retry the simulation control request' } }); return; }
    try { await simulator.setScenario(code, scenario.data as Scenario); }
    catch { response.status(503).json({ error: { code: 'DISTRIBUTED_CONTROL_UNAVAILABLE', message: 'Simulation control could not be synchronized' } }); return; }
    response.json({ data: { code, scenario: scenario.data }, simulated: true });
  });

  app.post('/api/v1/simulation/systems/:code/scenario', requireRole('ADMINISTRATOR'), async (request, response) => {
    if (!db || !simulator) { response.status(503).json({ error: { code: 'SIMULATOR_UNAVAILABLE' } }); return; }
    const scenario = z.enum(['NORMAL', 'RECOVERY', 'MISSING_HEARTBEAT', 'NETWORK_DISCONNECTION']).safeParse(request.body?.scenario);
    if (!scenario.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid shared scenario' } }); return; }
    const code = String(request.params.code).toUpperCase();
    const system = await db.logicalSystem.findUnique({ where: { code }, include: { devices: { select: { code: true } } } });
    if (!system) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'System not found' } }); return; }
    if (scenario.data === 'NETWORK_DISCONNECTION' && ['UPS', 'COOLING'].includes(code)) { response.status(409).json({ error: { code: 'SCENARIO_NOT_SUPPORTED', message: 'Network scenario is not supported by this system' } }); return; }
    if (!simulationControlAvailable()) { response.status(503).json({ error: { code: 'DISTRIBUTED_CONTROL_UNAVAILABLE', message: 'Redis coordination is reconnecting; retry the simulation control request' } }); return; }
    try { for (const device of system.devices) await simulator.setScenario(device.code, scenario.data); }
    catch { response.status(503).json({ error: { code: 'DISTRIBUTED_CONTROL_UNAVAILABLE', message: 'Simulation control could not be synchronized' } }); return; }
    response.json({ data: { code, scenario: scenario.data, deviceCodes: system.devices.map(device => device.code) }, simulated: true });
  });

  app.get('/api/v1/diagnoses', async (request, response) => {
    if (!db) throw new Error('Database unavailable');
    const parsed = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), active: z.enum(['true', 'false']).optional() }).safeParse(request.query);
    if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid diagnosis query' } }); return; }
    const data = await db.faultDiagnosis.findMany({
      where: parsed.data.active === 'true' ? { resolvedAt: null } : parsed.data.active === 'false' ? { resolvedAt: { not: null } } : undefined,
      take: parsed.data.limit, orderBy: { detectedAt: 'desc' },
      include: { device: { select: { code: true, name: true, system: { select: { code: true, name: true, availability: true } } } }, confirmedBy: { select: { name: true } } },
    });
    const enriched = await Promise.all(data.map(async item => ({
      ...item,
      previousSimilarFailures: await db.faultDiagnosis.count({ where: { deviceId: item.deviceId, ruleCode: item.ruleCode, detectedAt: { lt: item.detectedAt } } }),
    })));
    response.json({ data: enriched, thresholds: diagnosticThresholds(), simulated: true });
  });

  app.patch('/api/v1/diagnoses/:id/confirm', requireRole('ADMINISTRATOR', 'SUPERVISOR', 'MAINTENANCE_ENGINEER'), async (request, response) => {
    if (!db) throw new Error('Database unavailable');
    const parsed = z.strictObject({ rootCause: z.string().trim().min(5).max(500) }).safeParse(request.body);
    if (!parsed.success || !z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid root cause is required' } }); return; }
    const id = String(request.params.id);
    const existing = await db.faultDiagnosis.findUnique({ where: { id }, select: { id: true } });
    if (!existing) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Diagnosis not found' } }); return; }
    const data = await db.faultDiagnosis.update({ where: { id }, data: { confirmedRootCause: parsed.data.rootCause, confirmedById: (response.locals.user as PublicUser).id, confirmedAt: new Date() } });
    response.json({ data, simulated: true });
  });

  app.get('/api/v1/alarms', async (request, response) => {
    if (!db) throw new Error('Database unavailable');
    const parsed = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), active: z.enum(['true', 'false']).optional() }).safeParse(request.query);
    if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid alarm query' } }); return; }
    const alarms = await db.alarm.findMany({
      where: parsed.data.active === 'true' ? { resolvedAt: null } : parsed.data.active === 'false' ? { resolvedAt: { not: null } } : undefined,
      take: parsed.data.limit, orderBy: { createdAt: 'desc' },
      include: {
        device: { select: { code: true, name: true, role: true, system: { select: { code: true, name: true, availability: true, failoverEvents: { take: 1, orderBy: { detectedAt: 'desc' }, select: { result: true, toDevice: { select: { code: true, name: true } } } } } } } },
        diagnosis: { select: { suspectedCause: true, confirmedRootCause: true, component: true, symptoms: true, supportingTelemetry: true, serviceImpact: true, investigationSteps: true, recoveryAction: true } },
        acknowledgements: { select: { userId: true, acknowledgedAt: true, user: { select: { name: true } } } },
      },
    });
    const user = response.locals.user as PublicUser;
    response.json({ data: alarms.map(({ acknowledgements, device, ...alarm }) => ({ ...alarm, device: { ...device, system: { ...device.system, failover: device.system.failoverEvents[0] ?? null, failoverEvents: undefined } }, acknowledged: acknowledgements.length > 0, acknowledgedByMe: acknowledgements.some(item => item.userId === user.id), acknowledgedAt: acknowledgements[0]?.acknowledgedAt ?? null, acknowledgedBy: acknowledgements[0]?.user.name ?? null })), escalationAfterMs: escalationDelay(), simulated: true });
  });

  app.post('/api/v1/alarms/:id/acknowledge', async (request, response) => {
    if (!db) throw new Error('Database unavailable');
    if (!z.uuid().safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid alarm ID' } }); return; }
    const id = String(request.params.id);
    const alarm = await db.alarm.findUnique({ where: { id }, select: { id: true } });
    if (!alarm) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alarm not found' } }); return; }
    const userId = (response.locals.user as PublicUser).id;
    const acknowledgement = await db.alarmAcknowledgement.upsert({ where: { alarmId_userId: { alarmId: id, userId } }, create: { alarmId: id, userId }, update: {} });
    response.json({ data: acknowledgement, simulated: true });
  });

  app.get('/api/v1/monitoring/snapshot', async (_request, response) => {
    if (!db) {
      response.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database not configured' } });
      return;
    }
    const devices = await db.$queryRaw<Array<{
      id: string; code: string; name: string; role: string; health: string; activationState: string;
      maintenanceStatus: string; maintenanceEligible: boolean; system: { code: string; name: string; availability: string };
      latestTelemetry: Record<string, unknown> | null; latestHeartbeatAt: Date | null;
    }>>`
      SELECT d."id", d."code", d."name", d."role"::text AS "role", d."health"::text AS "health",
        d."activationState"::text AS "activationState", d."maintenanceStatus"::text AS "maintenanceStatus",
        d."maintenanceEligible", jsonb_build_object('code', s."code", 'name', s."name", 'availability', s."availability"::text) AS "system",
        CASE WHEN t."id" IS NULL THEN NULL ELSE jsonb_build_object(
          'id', t."id", 'recordedAt', t."recordedAt", 'temperatureC', t."temperatureC", 'cpuPercent', t."cpuPercent",
          'memoryPercent', t."memoryPercent", 'diskPercent', t."diskPercent", 'latencyMs', t."latencyMs",
          'packetLossPct', t."packetLossPct", 'voltageV', t."voltageV", 'currentA', t."currentA", 'fanRpm', t."fanRpm",
          'batteryPct', t."batteryPct", 'signalPct', t."signalPct", 'simulated', t."simulated") END AS "latestTelemetry",
        h."recordedAt" AS "latestHeartbeatAt"
      FROM "Device" d
      JOIN "LogicalSystem" s ON s."id" = d."systemId"
      LEFT JOIN LATERAL (SELECT tr."id", tr."recordedAt", tr."temperatureC", tr."cpuPercent", tr."memoryPercent",
        tr."diskPercent", tr."latencyMs", tr."packetLossPct", tr."voltageV", tr."currentA", tr."fanRpm",
        tr."batteryPct", tr."signalPct", tr."simulated" FROM "TelemetryReading" tr WHERE tr."deviceId" = d."id"
        ORDER BY tr."recordedAt" DESC LIMIT 1) t ON TRUE
      LEFT JOIN LATERAL (SELECT hb."recordedAt" FROM "Heartbeat" hb WHERE hb."deviceId" = d."id"
        ORDER BY hb."recordedAt" DESC LIMIT 1) h ON TRUE
      ORDER BY s."code" ASC, d."role" ASC`;
    response.json({
      recordedAt: new Date().toISOString(),
      simulated: true,
      data: devices,
    });
  });

  app.get('/api/v1/devices/:code/telemetry', async (request, response) => {
    if (!db) {
      response.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database not configured' } });
      return;
    }
    const query = z.strictObject({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }).safeParse(request.query);
    if (!query.success) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid pagination' } });
      return;
    }
    const code = String(request.params.code).toUpperCase();
    const device = await db.device.findUnique({ where: { code }, select: { id: true, code: true } });
    if (!device) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
      return;
    }
    const { page, limit } = query.data;
    const [total, data, heartbeat] = await db.$transaction([
      db.telemetryReading.count({ where: { deviceId: device.id } }),
      db.telemetryReading.findMany({ where: { deviceId: device.id }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      db.heartbeat.findFirst({ where: { deviceId: device.id }, orderBy: { recordedAt: 'desc' }, select: { recordedAt: true } }),
    ]);
    response.json({ deviceCode: device.code, data, page, limit, total, latestHeartbeatAt: heartbeat?.recordedAt ?? null, simulated: true });
  });

  app.get('/api/v1/notes', (_request, response) => {
    response.json({ data: [...notes.values()], simulated: true });
  });

  app.get('/api/v1/notes/:id', (request, response) => {
    const note = notes.get(String(request.params.id));
    if (!note) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Note not found' } });
      return;
    }
    response.json({ data: note, simulated: true });
  });

  app.post('/api/v1/notes', requireRole('ADMINISTRATOR'), (request, response) => {
    const parsed = noteInput.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid note',
          details: parsed.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })),
        },
      });
      return;
    }

    const note: Note = { id: randomUUID(), ...parsed.data, createdAt: new Date().toISOString() };
    notes.set(note.id, note);
    response.status(201).location(`/api/v1/notes/${note.id}`).json({ data: note, simulated: true });
  });

  app.get('/api/v1/analytics/telemetry', async (request, response) => {
    if (!db) { response.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Telemetry requires PostgreSQL' } }); return; }
    const input = z.strictObject({ device: z.string().min(1).max(48), days: z.coerce.number().int().refine(value => [7, 30, 90].includes(value)).default(7) }).safeParse(request.query);
    if (!input.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose a device and a 7, 30 or 90 day window' } }); return; }
    const device = await db.device.findUnique({ where: { code: input.data.device }, select: { id: true, code: true } });
    if (!device) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } }); return; }
    const from = new Date(Date.now() - input.data.days * 86_400_000);
    type Row = { bucket: Date; temperatureC: number | null; cpuPercent: number | null; packetLossPct: number | null };
    const data = input.data.days === 90
      ? await db.$queryRaw<Row[]>`SELECT date_trunc('day', "recordedAt") AS "bucket", AVG("temperatureC") AS "temperatureC", AVG("cpuPercent") AS "cpuPercent", AVG("packetLossPct") AS "packetLossPct" FROM "TelemetryReading" WHERE "deviceId" = ${device.id}::uuid AND "recordedAt" >= ${from} GROUP BY 1 ORDER BY 1 ASC`
      : await db.$queryRaw<Row[]>`SELECT date_trunc('hour', "recordedAt") AS "bucket", AVG("temperatureC") AS "temperatureC", AVG("cpuPercent") AS "cpuPercent", AVG("packetLossPct") AS "packetLossPct" FROM "TelemetryReading" WHERE "deviceId" = ${device.id}::uuid AND "recordedAt" >= ${from} GROUP BY 1 ORDER BY 1 ASC`;
    response.json({ device: device.code, bucket: input.data.days === 90 ? 'UTC_DAY' : 'UTC_HOUR', data, simulated: true });
  });

  app.get('/api/v1/analytics/reliability', async (request, response) => {
    const input = z.strictObject({ dataset: z.enum(['recorded', 'demo']).default('recorded'), days: z.coerce.number().int().refine(value => [7, 30, 90].includes(value)).default(30) }).safeParse(request.query);
    if (!input.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose recorded or demo data and a 7, 30 or 90 day window' } }); return; }
    if (input.data.dataset === 'recorded' && !db) { response.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Recorded analytics require PostgreSQL' } }); return; }
    const key = `${input.data.dataset}:${input.data.days}`;
    const cached = analyticsCache.get(key);
    if (cached && cached.until > Date.now()) { response.json(cached.value); return; }
    const to = new Date();
    const from = new Date(to.getTime() - input.data.days * 86_400_000);
    const source = input.data.dataset === 'demo' ? historicalDemoInput(to) : await recordedAnalyticsInput(db!, from, to, heartbeatPolicy.expectedIntervalMs);
    const result = { data: calculateReliability(source, from, to, input.data.dataset === 'demo' ? 'HISTORICAL_DEMO' : 'RECORDED'), simulated: true,
      note: input.data.dataset === 'demo' ? 'Illustrative historical demo events generated for this dashboard. Not observed project performance.' : 'Calculated from persisted simulation records in the selected window.' };
    analyticsCache.set(key, { until: Date.now() + 30_000, value: result });
    response.json(result);
  });

  if (db) app.use('/api/v1', incidentRoutes(db, incidents ?? new IncidentService(db)));
  if (db) app.use('/api/v1', notificationRoutes(db));
  if (db) app.use('/api/v1', recommendationRoutes(db));
  if (db) app.use('/api/v1', documentRoutes(db), reportRoutes(db));

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
      return;
    }
    if (error instanceof IncidentError || error instanceof MaintenanceError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 409;
      response.status(status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    console.error('Unhandled API error', error);
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  };
  app.use(errorHandler);

  return app;
}
