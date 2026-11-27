import type { Database } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { randomUUID } from 'node:crypto';
import type { NotificationKind, NotificationPriority } from '../generated/prisma/enums.js';

const priorityRank: Record<NotificationPriority, number> = { INFORMATION: 0, WARNING: 1, MAJOR: 2, CRITICAL: 3 };

export type NotificationInput = {
  sourceKey: string; kind: NotificationKind; priority: NotificationPriority;
  title: string; body: string; deviceId?: string; userIds?: string[];
};

export async function recordNotification(tx: Prisma.TransactionClient, input: NotificationInput) {
  const { userIds, ...eventInput } = input;
  const targets = await tx.user.findMany({ where: { active: true, OR: [{ role: { in: ['ADMINISTRATOR', 'SUPERVISOR'] } }, ...(userIds?.length ? [{ id: { in: userIds } }] : [])] }, select: { id: true, notificationPreference: { select: { inAppEnabled: true, minimumPriority: true } } } });
  const event = await tx.notificationEvent.create({ data: eventInput });
  const addressed = targets.map(target => ({ target, recipientId: randomUUID() }));
  if (addressed.length) {
    await tx.notificationRecipient.createMany({ data: addressed.map(({ target, recipientId }) => ({ id: recipientId, eventId: event.id, userId: target.id })) });
    await tx.notificationDelivery.createMany({ data: addressed.map(({ target, recipientId }) => ({ id: randomUUID(), recipientId, channel: 'IN_APP', status: target.notificationPreference?.inAppEnabled !== false && priorityRank[input.priority] >= priorityRank[target.notificationPreference?.minimumPriority ?? 'INFORMATION'] ? 'PENDING' : 'DISABLED' })) });
  }
  return targets.map(target => target.id);
}

/** Durable in-app outbox. It deliberately has no external transport until one is configured and consented. */
export class NotificationService {
  constructor(private readonly db: Database, private readonly onChanged?: (userIds: string[]) => void) {}

  async record(input: NotificationInput) {
    let affected: string[];
    try {
      affected = await this.db.$transaction(async tx => {
      const existing = await tx.notificationEvent.findUnique({ where: { sourceKey: input.sourceKey }, select: { id: true } });
      if (existing) return [] as string[];
      return recordNotification(tx, input);
      }, { maxWait: 5000, timeout: 15000 });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return [];
      throw error;
    }
    if (affected.length) this.onChanged?.(affected);
    return affected;
  }

  async dispatchDue(limit = 100, deliver?: (userId: string) => Promise<void> | void) {
    const due = await this.db.notificationDelivery.findMany({ where: { channel: 'IN_APP', status: 'PENDING', nextAttemptAt: { lte: new Date() }, attemptCount: { lt: 5 } }, take: Math.min(limit, 100), orderBy: { createdAt: 'asc' }, select: { id: true, attemptCount: true, recipient: { select: { userId: true } } } });
    if (!due.length) return 0;
    for (const item of due) {
      const at = new Date();
      try {
        await deliver?.(item.recipient.userId);
        await this.db.notificationDelivery.update({ where: { id: item.id }, data: { status: 'DELIVERED', attemptCount: { increment: 1 }, lastAttemptAt: at, deliveredAt: at, lastError: null } });
      } catch (error) {
        const attempts = item.attemptCount + 1;
        await this.db.notificationDelivery.update({ where: { id: item.id }, data: { status: attempts >= 5 ? 'FAILED' : 'PENDING', attemptCount: attempts, lastAttemptAt: at, nextAttemptAt: new Date(at.getTime() + Math.min(300_000, 1_000 * 2 ** attempts)), lastError: String(error instanceof Error ? error.message : error).slice(0, 500) } });
      }
    }
    return due.length;
  }
}
