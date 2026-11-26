import type { Database } from '../db.js';
import type { UserRole, WorkOrderStatus } from '../generated/prisma/enums.js';

const ordered: WorkOrderStatus[] = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'VERIFICATION', 'COMPLETED'];
export const recurrenceDays = (frequency: string, custom?: number | null) => ({ DAILY: 1, WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91, HALF_YEARLY: 182, YEARLY: 365, CUSTOM: custom ?? 0 }[frequency] ?? 0);
export class MaintenanceError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export class MaintenanceService {
  constructor(private readonly db: Database) {}
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
    const order = await this.db.maintenanceWorkOrder.findUnique({ where: { id }, select: { status: true, assignedEngineerId: true } });
    if (!order) throw new MaintenanceError('NOT_FOUND', 'Work order not found');
    if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new MaintenanceError('FINALIZED', 'Finalized work orders are immutable');
    if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role) && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only assigned engineer may add parts');
    return this.db.workOrderPartUsage.create({ data: { workOrderId: id, ...input } });
  }
  async generateDue(at = new Date()) {
    const plans = await this.db.maintenancePlan.findMany({ where: { active: true, nextScheduledAt: { lte: at } }, take: 100, include: { device: true } });
    for (const plan of plans) {
      const days = recurrenceDays(plan.frequency, plan.customIntervalDays);
      if (!days) continue;
      const occurrence = plan.nextScheduledAt;
      const key = `plan:${plan.id}:${occurrence.toISOString()}`;
      try {
        await this.db.maintenanceWorkOrder.create({ data: { occurrenceKey: key, title: plan.name, deviceId: plan.deviceId, systemId: plan.systemId, planId: plan.id, type: 'PREVENTIVE', priority: plan.priority, description: plan.description, status: 'SCHEDULED', assignedEngineerId: plan.assignedEngineerId, scheduledStartAt: occurrence, scheduledCompletionAt: new Date(occurrence.getTime() + plan.estimatedDurationMinutes * 60_000), estimatedDurationMinutes: plan.estimatedDurationMinutes, checklistItems: { create: (plan.checklist as string[]).map(description => ({ description })) }, transitions: { create: { toStatus: 'SCHEDULED', actorId: plan.updatedById, note: 'Generated from recurring simulated maintenance plan' } } } });
      } catch (error) { if ((error as { code?: string }).code !== 'P2002') throw error; }
      await this.db.maintenancePlan.update({ where: { id: plan.id }, data: { nextScheduledAt: new Date(occurrence.getTime() + days * 86_400_000) } });
    }
  }
  async transition(id: string, next: WorkOrderStatus, actor: { id: string; role: UserRole }, note?: string) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "MaintenanceWorkOrder" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const order = await tx.maintenanceWorkOrder.findUnique({ where: { id }, include: { checklistItems: true } });
      if (!order) throw new MaintenanceError('NOT_FOUND', 'Work order not found');
      const manager = actor.role === 'ADMINISTRATOR' || actor.role === 'SUPERVISOR';
      if (!manager && order.assignedEngineerId !== actor.id) throw new MaintenanceError('FORBIDDEN', 'Only the assigned engineer may update this work order');
      if (next === 'CANCELLED' && !manager) throw new MaintenanceError('FORBIDDEN', 'Supervisor cancellation required');
      if (ordered.indexOf(next) !== ordered.indexOf(order.status) + 1 && !['ON_HOLD', 'CANCELLED', 'REJECTED'].includes(next)) throw new MaintenanceError('INVALID_TRANSITION', 'Invalid work order transition');
      if (next === 'VERIFICATION' && order.checklistItems.some(item => !item.completed)) throw new MaintenanceError('CHECKLIST_INCOMPLETE', 'Complete every checklist item before verification');
      const now = new Date();
      const updated = await tx.maintenanceWorkOrder.update({ where: { id }, data: { status: next, actualStartAt: next === 'IN_PROGRESS' ? now : undefined, actualCompletionAt: next === 'COMPLETED' ? now : undefined, completedAt: next === 'COMPLETED' ? now : undefined } });
      await tx.workOrderStatusHistory.create({ data: { workOrderId: id, fromStatus: order.status, toStatus: next, actorId: actor.id, note } });
      return updated;
    });
  }
}
