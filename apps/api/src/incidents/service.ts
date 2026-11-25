import type { Database } from '../db.js';
import type { AlarmLevel, IncidentPriority, IncidentStatus, UserRole } from '../generated/prisma/enums.js';

const steps: IncidentStatus[] = ['DETECTED', 'ACKNOWLEDGED', 'ASSIGNED', 'UNDER_INVESTIGATION', 'UNDER_REPAIR', 'VERIFICATION', 'RESOLVED'];
const priorities: IncidentPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const priorityFor = (level: AlarmLevel): IncidentPriority => level === 'CRITICAL' ? 'URGENT' : level === 'MAJOR' ? 'HIGH' : level === 'WARNING' ? 'MEDIUM' : 'LOW';

export class IncidentError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID_TRANSITION' | 'INVALID_ASSIGNEE' | 'FORBIDDEN' | 'FAULT_ACTIVE' | 'APPROVAL_REQUIRED', message: string) { super(message); }
}

export class IncidentService {
  private syncing = false;
  constructor(private readonly db: Database, private readonly onChange?: () => void) {}
  notify() { this.onChange?.(); }

  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const alarms = await this.db.alarm.findMany({
        where: { incident: { is: null }, resolvedAt: null, level: { not: 'INFORMATION' } },
        take: 100, orderBy: { createdAt: 'asc' },
        select: { id: true, deviceId: true, level: true, message: true, createdAt: true },
      });
      for (const alarm of alarms) {
        try {
          await this.db.incident.create({ data: {
            alarmId: alarm.id, deviceId: alarm.deviceId, description: alarm.message,
            priority: priorityFor(alarm.level),
            createdAt: alarm.createdAt,
            events: { create: { kind: 'DETECTED', detail: 'Incident opened from simulated fault alarm', createdAt: alarm.createdAt } },
          } });
          this.onChange?.();
        } catch (error) {
          if ((error as { code?: string }).code !== 'P2002') throw error;
        }
      }
      const open = await this.db.incident.findMany({ where: { status: { not: 'RESOLVED' } }, select: { id: true, priority: true, alarm: { select: { level: true } } } });
      for (const incident of open) {
        const priority = priorityFor(incident.alarm.level);
        if (priorities.indexOf(priority) <= priorities.indexOf(incident.priority)) continue;
        await this.db.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Incident" WHERE "id" = ${incident.id}::uuid FOR UPDATE`;
          const current = await tx.incident.findUniqueOrThrow({ where: { id: incident.id }, select: { priority: true, status: true } });
          if (current.status === 'RESOLVED' || priorities.indexOf(priority) <= priorities.indexOf(current.priority)) return;
          await tx.incident.update({ where: { id: incident.id }, data: { priority } });
          await tx.incidentEvent.create({ data: { incidentId: incident.id, kind: 'PRIORITY_CHANGED', detail: `Priority escalated from ${current.priority} to ${priority}` } });
        }, { maxWait: 15000, timeout: 30000 });
        this.onChange?.();
      }
    } finally { this.syncing = false; }
  }

  async transition(id: string, next: IncidentStatus, actor: { id: string; role: UserRole }, assignedToId?: string) {
    const result = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Incident" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const incident = await tx.incident.findUnique({ where: { id }, include: { alarm: { select: { resolvedAt: true } } } });
      if (!incident) throw new IncidentError('NOT_FOUND', 'Incident not found');
      if (steps.indexOf(next) !== steps.indexOf(incident.status) + 1) throw new IncidentError('INVALID_TRANSITION', 'Move the incident to the next lifecycle step');
      if (next === 'ASSIGNED') {
        if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role)) throw new IncidentError('FORBIDDEN', 'A supervisor must assign the engineer');
        const assignee = assignedToId ? await tx.user.findUnique({ where: { id: assignedToId }, select: { role: true, active: true } }) : null;
        if (!assignee || !assignee.active || assignee.role !== 'MAINTENANCE_ENGINEER') throw new IncidentError('INVALID_ASSIGNEE', 'Choose an active maintenance engineer');
      } else if (assignedToId) throw new IncidentError('INVALID_ASSIGNEE', 'Assignment is only allowed at the Assigned step');
      if (next !== 'ACKNOWLEDGED' && next !== 'ASSIGNED' && actor.role === 'MAINTENANCE_ENGINEER' && incident.assignedToId !== actor.id) {
        throw new IncidentError('FORBIDDEN', 'Only the assigned engineer may advance this incident');
      }
      if (next === 'RESOLVED') {
        if (!incident.alarm.resolvedAt) throw new IncidentError('FAULT_ACTIVE', 'The source fault must clear before resolving the incident');
        if (incident.priority === 'URGENT' && !incident.approvedAt) throw new IncidentError('APPROVAL_REQUIRED', 'Supervisor approval is required for an urgent incident');
      }
      const at = new Date();
      const updated = await tx.incident.update({ where: { id }, data: {
        status: next, assignedToId: next === 'ASSIGNED' ? assignedToId : undefined,
        acknowledgedAt: next === 'ACKNOWLEDGED' ? at : undefined,
        repairStartedAt: next === 'UNDER_REPAIR' ? at : undefined,
        repairCompletedAt: next === 'VERIFICATION' ? at : undefined,
        resolvedAt: next === 'RESOLVED' ? at : undefined,
      } });
      await tx.incidentEvent.create({ data: {
        incidentId: id, actorId: actor.id, kind: 'STATUS_CHANGED',
        detail: next === 'ASSIGNED' ? `${incident.status} → ${next}; engineer assigned` : `${incident.status} → ${next}`,
      } });
      return updated;
    }, { maxWait: 15000, timeout: 30000 });
    this.onChange?.();
    return result;
  }

  async approve(id: string, actor: { id: string; role: UserRole }) {
    if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(actor.role)) throw new IncidentError('FORBIDDEN', 'Supervisor approval required');
    const result = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Incident" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const incident = await tx.incident.findUnique({ where: { id }, include: { alarm: { select: { resolvedAt: true } } } });
      if (!incident) throw new IncidentError('NOT_FOUND', 'Incident not found');
      if (incident.status !== 'VERIFICATION' || !incident.alarm.resolvedAt) throw new IncidentError('INVALID_TRANSITION', 'Verify the cleared fault before approval');
      if (incident.approvedAt) return incident;
      const updated = await tx.incident.update({ where: { id }, data: { approvedById: actor.id, approvedAt: new Date() } });
      await tx.incidentEvent.create({ data: { incidentId: id, actorId: actor.id, kind: 'APPROVED', detail: 'Supervisor approved incident closure' } });
      return updated;
    }, { maxWait: 15000, timeout: 30000 });
    this.onChange?.();
    return result;
  }
}
