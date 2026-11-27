import type { Database } from '../db.js';
import { diagnose, diagnosticThresholds } from './rules.js';

export class DiagnosisService {
  private running = false;
  constructor(private readonly db: Database, private readonly heartbeatTimeoutMs: number, private readonly heartbeatIntervalMs = 5000) {}

  async scan(at = new Date(), deviceId?: string) {
    if (this.running) return;
    this.running = true;
    try {
      const devices = await this.db.device.findMany({ where: deviceId ? { id: deviceId } : undefined, include: {
        telemetry: { take: 1, orderBy: { recordedAt: 'desc' } },
        heartbeats: { take: 1, orderBy: { recordedAt: 'desc' } },
        system: { select: { availability: true } },
      } });
      const thresholds = diagnosticThresholds();
      const affectedBySystem = new Map<string, number>();
      for (const device of devices) {
        if (device.maintenanceStatus && device.maintenanceStatus !== 'AVAILABLE') continue;
        const sample = device.telemetry[0];
        const last = device.heartbeats[0]?.recordedAt ?? device.createdAt;
        if (at.getTime() - last.getTime() >= this.heartbeatTimeoutMs || (sample?.packetLossPct != null && sample.packetLossPct >= thresholds.packetLossPct)) {
          affectedBySystem.set(device.systemId, (affectedBySystem.get(device.systemId) ?? 0) + 1);
        }
      }
      for (const device of devices) {
        if (device.maintenanceStatus && device.maintenanceStatus !== 'AVAILABLE') continue;
        const sample = device.telemetry[0];
        if (!sample) continue;
        const lastHeartbeat = device.heartbeats[0]?.recordedAt ?? device.createdAt;
        const findings = diagnose(sample, at.getTime() - lastHeartbeat.getTime() >= this.heartbeatTimeoutMs, thresholds);
        if ((affectedBySystem.get(device.systemId) ?? 0) >= 2 && (at.getTime() - lastHeartbeat.getTime() >= this.heartbeatTimeoutMs || (sample.packetLossPct != null && sample.packetLossPct >= thresholds.packetLossPct))) {
          findings.push({ ruleCode: 'SHARED_INFRASTRUCTURE', suspectedCause: 'Possible shared infrastructure failure', component: 'Shared network or power', severity: 'CRITICAL',
            symptoms: ['Multiple devices in one system affected'], supportingTelemetry: sample.packetLossPct == null ? {} : { packetLossPct: sample.packetLossPct },
            investigationSteps: ['Compare both device timelines', 'Inspect shared network and power paths'], recoveryAction: 'Redundancy manager may activate a healthy standby' });
        }
        const active = await this.db.faultDiagnosis.findMany({ where: { deviceId: device.id, resolvedAt: null } });
        const currentCodes = new Set(findings.map(item => item.ruleCode));
        for (const old of active) {
          if (!currentCodes.has(old.ruleCode)) await this.db.faultDiagnosis.update({ where: { id: old.id }, data: { resolvedAt: at } });
        }
        for (const finding of findings) {
          const previous = active.find(item => item.ruleCode === finding.ruleCode);
          const data = {
            suspectedCause: finding.suspectedCause, component: finding.component, severity: finding.severity,
            symptoms: finding.symptoms, supportingTelemetry: finding.supportingTelemetry,
            serviceImpact: device.system.availability === 'OUTAGE' ? 'Logical service outage' : device.activationState === 'ACTIVE' ? 'Active device at risk' : 'Standby redundancy at risk',
            investigationSteps: finding.investigationSteps, recoveryAction: finding.recoveryAction, lastSeenAt: at,
          };
          if (previous) await this.db.faultDiagnosis.update({ where: { id: previous.id }, data });
          else await this.db.faultDiagnosis.create({ data: { deviceId: device.id, ruleCode: finding.ruleCode, detectedAt: at,
            firstObservedAt: finding.ruleCode === 'MISSING_HEARTBEAT' ? new Date(lastHeartbeat.getTime() + this.heartbeatIntervalMs) : sample.recordedAt,
            ...data } });
        }
      }
    } finally { this.running = false; }
  }
}
