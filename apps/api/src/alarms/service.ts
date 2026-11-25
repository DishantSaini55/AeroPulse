import type { Database } from '../db.js';
import type { AlarmLevel } from '../generated/prisma/enums.js';

export type AlarmNotice = { id: string; level: AlarmLevel; message: string; deviceCode: string; createdAt: string; simulated: true };
const nextLevel: Record<AlarmLevel, AlarmLevel> = { INFORMATION: 'INFORMATION', WARNING: 'MAJOR', MAJOR: 'CRITICAL', CRITICAL: 'CRITICAL' };

export function escalationDelay() {
  const value = Number(process.env.ALARM_ESCALATE_AFTER_MS ?? 120000);
  if (!Number.isInteger(value) || value < 15000 || value > 3600000) throw new Error('ALARM_ESCALATE_AFTER_MS must be 15000–3600000');
  return value;
}

export class AlarmService {
  private running = false;
  constructor(private readonly db: Database, private readonly onNotice?: (event: AlarmNotice) => void, private readonly escalationMs = escalationDelay()) {}

  async sync(at = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const diagnoses = await this.db.faultDiagnosis.findMany({ where: { resolvedAt: null }, include: { device: { select: { code: true, name: true, system: { select: { name: true } } } } } });
      const activeIds = new Set(diagnoses.map(item => item.id));
      for (const diagnosis of diagnoses) {
        const key = `diagnosis:${diagnosis.id}`;
        let alarm = await this.db.alarm.findUnique({ where: { sourceKey: key }, include: { acknowledgements: { take: 1 } } });
        if (!alarm) {
          const level = diagnosis.severity as AlarmLevel;
          alarm = await this.db.alarm.create({ data: {
            sourceKey: key, diagnosisId: diagnosis.id, deviceId: diagnosis.deviceId, level, initialLevel: level,
            message: `${diagnosis.device.name}: ${diagnosis.suspectedCause}. ${diagnosis.serviceImpact}. Maintenance investigation requested.`,
            createdAt: diagnosis.detectedAt, simulated: true,
          }, include: { acknowledgements: { take: 1 } } });
          this.onNotice?.({ id: alarm.id, level: alarm.level, message: alarm.message, deviceCode: diagnosis.device.code, createdAt: alarm.createdAt.toISOString(), simulated: true });
        } else if (alarm.acknowledgements.length === 0 && at.getTime() - (alarm.lastEscalatedAt ?? alarm.createdAt).getTime() >= this.escalationMs && nextLevel[alarm.level] !== alarm.level) {
          const level = nextLevel[alarm.level];
          await this.db.alarm.update({ where: { id: alarm.id }, data: { level, lastEscalatedAt: at } });
          this.onNotice?.({ id: alarm.id, level, message: `Escalated: ${alarm.message}`, deviceCode: diagnosis.device.code, createdAt: at.toISOString(), simulated: true });
        }
      }
      const open = await this.db.alarm.findMany({ where: { resolvedAt: null, diagnosisId: { not: null } }, include: { device: { select: { code: true, name: true } } } });
      for (const alarm of open) {
        if (alarm.diagnosisId && !activeIds.has(alarm.diagnosisId)) {
          await this.db.alarm.update({ where: { id: alarm.id }, data: { resolvedAt: at } });
          const info = await this.db.alarm.create({ data: {
            sourceKey: `recovery:${alarm.diagnosisId}`, deviceId: alarm.deviceId, level: 'INFORMATION', initialLevel: 'INFORMATION',
            message: `${alarm.device.name}: fault symptoms cleared. Verify equipment before closing investigation.`, createdAt: at, resolvedAt: at, simulated: true,
          } });
          this.onNotice?.({ id: info.id, level: 'INFORMATION', message: info.message, deviceCode: alarm.device.code, createdAt: at.toISOString(), simulated: true });
        }
      }
    } finally { this.running = false; }
  }
}
