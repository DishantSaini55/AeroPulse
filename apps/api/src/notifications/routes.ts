import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';

const uuid = z.uuid();
const priority = z.enum(['INFORMATION', 'WARNING', 'MAJOR', 'CRITICAL']);

export function notificationRoutes(db: Database) {
  const router = Router();
  router.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/notifications', async (request, response) => {
    const input = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), unread: z.enum(['true', 'false']).optional() }).safeParse(request.query);
    if (!input.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid notification filters' } }); return; }
    const user = response.locals.user as PublicUser;
    const where = { userId: user.id, ...(input.data.unread === 'true' ? { readAt: null } : input.data.unread === 'false' ? { readAt: { not: null } } : {}) };
    const [data, unread] = await Promise.all([
      db.notificationRecipient.findMany({ where, take: input.data.limit, orderBy: { createdAt: 'desc' }, include: { event: { include: { device: { select: { code: true, name: true, system: { select: { code: true } } } } } }, deliveries: { where: { channel: 'IN_APP' }, select: { status: true, deliveredAt: true, attemptCount: true } } } }),
      db.notificationRecipient.count({ where: { userId: user.id, readAt: null } }),
    ]);
    response.setHeader('Cache-Control', 'no-store');
    response.json({ data, unread, simulated: true });
  });
  router.post('/notifications/:id/read', async (request, response) => {
    if (!uuid.safeParse(request.params.id).success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid notification ID' } }); return; }
    const user = response.locals.user as PublicUser;
    const id = String(request.params.id);
    const data = await db.$transaction(async tx => {
      await tx.notificationRecipient.updateMany({ where: { id, userId: user.id, readAt: null }, data: { readAt: new Date() } });
      return tx.notificationRecipient.findFirst({ where: { id, userId: user.id } });
    });
    if (!data) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found' } }); return; }
    response.json({ data, simulated: true });
  });
  router.post('/notifications/read-all', async (_request, response) => {
    const user = response.locals.user as PublicUser;
    const result = await db.notificationRecipient.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    response.json({ data: { updated: result.count }, simulated: true });
  });
  router.get('/notification-preferences', async (_request, response) => {
    const user = response.locals.user as PublicUser;
    const data = await db.notificationPreference.findUnique({ where: { userId: user.id } });
    response.json({ data: data ?? { userId: user.id, inAppEnabled: true, minimumPriority: 'INFORMATION' } });
  });
  router.patch('/notification-preferences', async (request, response) => {
    const input = z.strictObject({ inAppEnabled: z.boolean().optional(), minimumPriority: priority.optional() }).refine(value => Object.keys(value).length > 0).safeParse(request.body);
    if (!input.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid notification preferences' } }); return; }
    const user = response.locals.user as PublicUser;
    const data = await db.notificationPreference.upsert({ where: { userId: user.id }, create: { userId: user.id, ...input.data }, update: input.data });
    response.json({ data });
  });
  return router;
}
