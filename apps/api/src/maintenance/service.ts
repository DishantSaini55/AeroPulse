import type { Database } from '../db.js';
import type { UserRole, WorkOrderStatus, MaintenanceFrequency, WorkOrderPriority } from '../generated/prisma/enums.js';
import { recordNotification } from '../notifications/service.js';

const ordered: WorkOrderStatus[] = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'VERIFICATION', 'COMPLETED'];
export const recurrenceDays = (frequency: string, custom?: number | null) => ({ DAILY: 1, WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91, HALF_YEARLY: 182, YEARLY: 365, CUSTOM: custom ?? 0 }[frequency] ?? 0);
export class MaintenanceError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export class MaintenanceService {
  constructor(private readonly db: Database) {}
  async updatePlan(id: string, input: { name?: string; deviceId?: string; category?: string; description?: string; checklist?: string[];
    frequency?: MaintenanceFrequency; customIntervalDays?: number; advanceNoticeDays?: number; estimatedDurationMinutes?: number;
    priority?: WorkOrderPriority; assignedEngineerId?: string | null; active?: boolean }, actorId: string) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "MaintenancePlan" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = await tx.maintenancePlan.findUnique({ where: { id } });
      if (!current) throw new MaintenanceError('NOT_FOUND', 'Plan not found');
      const merged = { ...current, ...input };
      if (recurrenceDays(merged.frequency, merged.customIntervalDays) <= 0) throw new MaintenanceError('INVALID_FREQUENCY', 'Custom recurrence requires a positive interval');
      const device = await tx.device.findUnique({ where: { id: merged.deviceId }, select: { systemId: true } });
      if (!device) throw new MaintenanceError('DEVICE_NOT_FOUND', 'Device not found');
      if (merged.assignedEngineerId) {
        const engineer = await tx.user.findUnique({ where: { id: merged.assignedEngineerId } });
        if (!engineer?.active || engineer.role !== 'MAINTENANCE_ENGINEER') throw new MaintenanceError('INVALID_ENGINEER', 'Choose an active maintenance engineer');
      }
      return tx.maintenancePlan.update({ where: { id }, data: { ...input, systemId: device.systemId, updatedById: actorId } });
    });
  }
  async createPlan(input: { name: string; deviceId: string; category: string; description: string; checklist: string[]; frequency: any; customIntervalDays?: number; advanceNoticeDays: number; estimatedDurationMinutes: number; priority: any; assignedEngineerId?: string }, actorId: string) {
    const device = await this.db.device.findUnique({ where: { id: input.deviceId }, select: { systemId: true } });
    if (!device) throw new MaintenanceError('DEVICE_NOT_FOUND', 'Device not found');
    const days = recurrenceDays(input.frequency, input.customIntervalDays);
    if (!days) throw new MaintenanceError('INVALID_FREQUENCY', 'Custom interval must be at least one day');
    if (input.assignedEngineerId) { const engineer = await this.db.user.findUnique({ where: { id: input.assignedEngineerId }, select: { active: true, role: true } }); if (!engineer || !engineer.active || engineer.role !== 'MAINTENANCE_ENGINEER') throw new MaintenanceError('INVALID_ENGINEER', 'Choose an active maintenance engineer'); }
    const now = new Date();
    return this.db.maintenancePlan.create({ data: { ...input, systemId: device.systemId, checklist: input.checklist, nextScheduledAt: new Date(now.getTime() + days * 86_400_000), createdById: actorId, updatedById: actorId } });
  }
  async addPart(id: string, input: { partName: string; partNumber?: string; quantity: number; unitCost: number }, actor: { id: string; role: UserRole }) {
    return this.db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const order = await tx.maintenanceWorkOrder.findUnique({ where: { id }, select: { status: true, assignedEngineerId: true } });
    if (!order) throw new MaintenanceError('NOT_FOUND', 'Work order not found');
    if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new MaintenanceError('FINALIZED', 'Finalized work orders are immutable');
    if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role) && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only assigned engineer may add parts');
    return tx.workOrderPartUsage.create({ data: { workOrderId: id, ...input } });
    });
  }
  async generateDue(at = new Date(), allowed: () => boolean = () => true) {
    const previews = await this.db.maintenancePlan.findMany({ where: { active: true, nextScheduledAt: { lte: at } }, orderBy: { nextScheduledAt: 'asc' }, take: 100, select: { id: true } });
    let generated = 0;
    for (const preview of previews) {
      if (!allowed()) break;
      generated += await this.db.$transaction(async tx => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "MaintenancePlan" WHERE "id" = ${preview.id}::uuid FOR UPDATE SKIP LOCKED`;
        if (!locked.length || !allowed()) return 0;
        const plan = await tx.maintenancePlan.findUniqueOrThrow({ where: { id: preview.id } });
        const days = recurrenceDays(plan.frequency, plan.customIntervalDays);
        if (!plan.active || days <= 0) return 0;
        let occurrence = plan.nextScheduledAt;
        let count = 0;
        // Preserve missed occurrences, draining at most three per plan per scan.
        while (occurrence <= at && count < 3 && allowed()) {
          const key = `plan:${plan.id}:${occurrence.toISOString()}`;
          const existing = await tx.maintenanceWorkOrder.findUnique({ where: { occurrenceKey: key }, select: { id: true } });
          if (!existing) {
          const created = await tx.maintenanceWorkOrder.create({ data: {
            occurrenceKey: key, title: plan.name, deviceId: plan.deviceId, systemId: plan.systemId, planId: plan.id,
            type: 'PREVENTIVE', priority: plan.priority, description: plan.description, status: 'SCHEDULED',
            assignedEngineerId: plan.assignedEngineerId, scheduledStartAt: occurrence,
            scheduledCompletionAt: new Date(occurrence.getTime() + plan.estimatedDurationMinutes * 60_000),
            estimatedDurationMinutes: plan.estimatedDurationMinutes,
            checklistItems: { create: (plan.checklist as string[]).map(description => ({ description })) },
            transitions: { create: { toStatus: 'SCHEDULED', actorId: plan.updatedById, note: 'Recurring simulated maintenance occurrence' } },
          } });
          if (plan.assignedEngineerId) await recordNotification(tx, { sourceKey: `maintenance:assigned:${created.id}`, kind: 'MAINTENANCE_ASSIGNED', priority: plan.priority === 'URGENT' ? 'CRITICAL' : plan.priority === 'HIGH' ? 'MAJOR' : 'INFORMATION', title: 'Maintenance work scheduled', body: plan.name, deviceId: plan.deviceId, userIds: [plan.assignedEngineerId] });
          }
          occurrence = new Date(occurrence.getTime() + days * 86_400_000);
          count++;
        }
        if (count) await tx.maintenancePlan.update({ where: { id: plan.id }, data: { nextScheduledAt: occurrence } });
        return count;
      }, { maxWait: 15000, timeout: 30000 });
    }
    return generated;
  }
  async transition(id: string, next: WorkOrderStatus, actor: { id: string; role: UserRole }, note?: string) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const order = await tx.maintenanceWorkOrder.findUnique({ where: { id }, include: { checklistItems: true } });
      if (!order) throw new MaintenanceError('NOT_FOUND', 'Work order not found');
      if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new MaintenanceError('FINALIZED', 'Finalized work order is immutable');
      if (next === 'IN_PROGRESS' || next === 'COMPLETED') throw new MaintenanceError('ACTIVATION_SAFETY_PENDING', 'Start and completion require Prompt 4C');
      const manager = actor.role === 'ADMINISTRATOR' || actor.role === 'SUPERVISOR';
      if (!manager && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only the assigned engineer may update this work order');
      if (next === 'CANCELLED' && !manager) throw new MaintenanceError('FORBIDDEN', 'Supervisor cancellation required');
      if (ordered.indexOf(next) !== ordered.indexOf(order.status) + 1 && !['ON_HOLD', 'CANCELLED', 'REJECTED'].includes(next)) throw new MaintenanceError('INVALID_TRANSITION', 'Invalid work order transition');
      if (next === 'VERIFICATION' && order.checklistItems.some(item => !item.completed)) throw new MaintenanceError('CHECKLIST_INCOMPLETE', 'Complete every checklist item before verification');
      const updated = await tx.maintenanceWorkOrder.update({ where: { id }, data: { status: next } });
      const history = await tx.workOrderStatusHistory.create({ data: { workOrderId: id, fromStatus: order.status, toStatus: next, actorId: actor.id, note } });
      await recordNotification(tx, { sourceKey: `maintenance:history:${history.id}`, kind: 'MAINTENANCE_ASSIGNED', priority: order.priority === 'URGENT' ? 'CRITICAL' : 'WARNING', title: `Maintenance ${next.toLowerCase()}`, body: `${order.title}: ${order.status} to ${next}`, deviceId: order.deviceId, userIds: order.assignedEngineerId ? [order.assignedEngineerId] : [] });
      return updated;
    });
  }
}
