import type { Database } from '../db.js';
import type { AnalyticsInput } from './metrics.js';

export async function recordedAnalyticsInput(db: Database, from: Date, to: Date, heartbeatIntervalMs = 5000): Promise<AnalyticsInput> {
  // Keep each batch below the pool size so monitoring transactions retain connections.
  const [devices, heartbeatCounts] = await Promise.all([
    db.device.findMany({ select: { id: true, code: true, system: { select: { code: true } } } }),
    db.heartbeat.groupBy({ by: ['deviceId'], where: { recordedAt: { gte: from, lte: to } }, _count: { _all: true } }),
  ]);
  const [diagnoses, outageAlarms, incidents] = await Promise.all([
    db.faultDiagnosis.findMany({ where: { detectedAt: { lte: to }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }] }, select: { deviceId: true, ruleCode: true, component: true, confirmedRootCause: true, firstObservedAt: true, detectedAt: true, resolvedAt: true } }),
    db.alarm.findMany({ where: { sourceKey: { startsWith: 'outage:' }, createdAt: { lte: to }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }] }, select: { createdAt: true, resolvedAt: true, device: { select: { system: { select: { code: true } } } } } }),
    db.incident.findMany({ where: { OR: [{ createdAt: { gte: from, lte: to } }, { repairCompletedAt: { gte: from, lte: to } }] }, select: { deviceId: true, createdAt: true, acknowledgedAt: true, repairStartedAt: true, repairCompletedAt: true } }),
  ]);
  const [failovers, repairs, replacements] = await Promise.all([
    db.failoverEvent.findMany({ where: { action: 'AUTOMATIC_FAILOVER', detectedAt: { gte: from, lte: to } }, select: { result: true, durationMs: true, detectedAt: true, system: { select: { code: true } } } }),
    db.repairRecord.findMany({ where: { createdAt: { gte: from, lte: to } }, select: { cost: true, createdAt: true, incident: { select: { deviceId: true } } } }),
    db.deviceReplacement.findMany({ where: { replacedAt: { gte: from, lte: to } }, select: { deviceId: true, cost: true, replacedAt: true } }),
  ]);
  const counts = new Map(heartbeatCounts.map(item => [item.deviceId, item._count._all]));
  return {
    devices: devices.map(item => ({ id: item.id, code: item.code, systemCode: item.system.code, healthyObservedMs: (counts.get(item.id) ?? 0) * heartbeatIntervalMs })),
    diagnoses,
    outages: outageAlarms.map(item => ({ systemCode: item.device.system.code, createdAt: item.createdAt, resolvedAt: item.resolvedAt })),
    incidents,
    failovers: failovers.map(item => ({ systemCode: item.system.code, result: item.result, durationMs: item.durationMs, detectedAt: item.detectedAt })),
    expenses: [...repairs.map(item => ({ deviceId: item.incident.deviceId, at: item.createdAt, amount: Number(item.cost), kind: 'REPAIR' as const })),
      ...replacements.map(item => ({ deviceId: item.deviceId, at: item.replacedAt, amount: Number(item.cost), kind: 'REPLACEMENT' as const }))],
  };
}

export function historicalDemoInput(to: Date): AnalyticsInput {
  const day = 86_400_000;
  const ago = (days: number, minutes = 0) => new Date(to.getTime() - days * day - minutes * 60_000);
  const devices = [
    { id: 'demo-amss-p', code: 'AMSS-P', systemCode: 'AMSS', healthyObservedMs: 100 * day },
    { id: 'demo-amss-s', code: 'AMSS-S', systemCode: 'AMSS', healthyObservedMs: 100 * day },
    { id: 'demo-ils-p', code: 'ILS-P', systemCode: 'ILS', healthyObservedMs: 100 * day },
    { id: 'demo-ils-s', code: 'ILS-S', systemCode: 'ILS', healthyObservedMs: 100 * day },
    { id: 'demo-radar-p', code: 'RADAR-P', systemCode: 'RADAR', healthyObservedMs: 100 * day },
    { id: 'demo-radar-s', code: 'RADAR-S', systemCode: 'RADAR', healthyObservedMs: 100 * day },
  ];
  const cases = [
    { deviceId: 'demo-amss-p', days: 86, ruleCode: 'COOLING_FAN', component: 'Cooling fan', cause: 'Fan bearing wear', minutes: 150, cost: 4200, missed: false },
    { deviceId: 'demo-ils-p', days: 73, ruleCode: 'MISSING_HEARTBEAT', component: 'Network interface', cause: 'Loose network connector', minutes: 95, cost: 800, missed: true },
    { deviceId: 'demo-radar-p', days: 61, ruleCode: 'POWER_SUPPLY', component: 'Power supply', cause: 'Input supply fluctuation', minutes: 180, cost: 1250, missed: false },
    { deviceId: 'demo-amss-p', days: 44, ruleCode: 'COOLING_FAN', component: 'Cooling fan', cause: 'Fan bearing wear', minutes: 110, cost: 5600, missed: false },
    { deviceId: 'demo-ils-p', days: 34, ruleCode: 'MISSING_HEARTBEAT', component: 'Network interface', cause: 'Loose network connector', minutes: 60, cost: 600, missed: true },
    { deviceId: 'demo-radar-p', days: 26, ruleCode: 'NETWORK_DEGRADATION', component: 'Network path', cause: 'Switch port fault', minutes: 45, cost: 500, missed: false },
    { deviceId: 'demo-amss-p', days: 21, ruleCode: 'COOLING_FAN', component: 'Cooling fan', cause: 'Fan bearing wear', minutes: 125, cost: 3500, missed: false },
    { deviceId: 'demo-ils-p', days: 12, ruleCode: 'MISSING_HEARTBEAT', component: 'Network interface', cause: 'Loose network connector', minutes: 75, cost: 900, missed: true },
    { deviceId: 'demo-radar-p', days: 8, ruleCode: 'NETWORK_DEGRADATION', component: 'Network path', cause: 'Switch port fault', minutes: 55, cost: 750, missed: false },
    { deviceId: 'demo-amss-p', days: 4, ruleCode: 'STORAGE_PRESSURE', component: 'Storage', cause: 'Old storage module', minutes: 140, cost: 7600, missed: false },
    { deviceId: 'demo-ils-p', days: 2, ruleCode: 'MISSING_HEARTBEAT', component: 'Network interface', cause: 'Loose network connector', minutes: 48, cost: 400, missed: true },
  ];
  const diagnoses = cases.map(item => {
    const detectedAt = ago(item.days);
    return { deviceId: item.deviceId, ruleCode: item.ruleCode, component: item.component, confirmedRootCause: item.cause,
      firstObservedAt: new Date(detectedAt.getTime() - (item.missed ? 15 : 3) * 60_000), detectedAt,
      resolvedAt: new Date(detectedAt.getTime() + item.minutes * 60_000) };
  });
  diagnoses.push({ deviceId: 'demo-ils-s', ruleCode: 'MISSING_HEARTBEAT', component: 'Network interface', confirmedRootCause: 'Shared network interruption',
    firstObservedAt: ago(34, 15), detectedAt: ago(34), resolvedAt: new Date(ago(34).getTime() + 25 * 60_000) });
  const incidents = cases.map(item => {
    const createdAt = ago(item.days);
    return { deviceId: item.deviceId, createdAt, acknowledgedAt: new Date(createdAt.getTime() + 8 * 60_000),
      repairStartedAt: new Date(createdAt.getTime() + 20 * 60_000), repairCompletedAt: new Date(createdAt.getTime() + (item.minutes - 10) * 60_000) };
  });
  const outages = [{ systemCode: 'ILS', createdAt: ago(34), resolvedAt: new Date(ago(34).getTime() + 25 * 60_000) }];
  const failovers = cases.filter(item => item.missed || item.ruleCode === 'POWER_SUPPLY').map((item, index) => ({ systemCode: devices.find(device => device.id === item.deviceId)!.systemCode,
    result: index === 2 ? 'NO_HEALTHY_STANDBY' : 'SUCCESS', durationMs: 900 + index * 130, detectedAt: ago(item.days) }));
  const expenses = [...cases.map(item => ({ deviceId: item.deviceId, at: new Date(ago(item.days).getTime() + item.minutes * 60_000), amount: item.cost, kind: 'REPAIR' as const })),
    { deviceId: 'demo-amss-p', at: ago(3), amount: 24000, kind: 'REPLACEMENT' as const }];
  return { devices, diagnoses, outages, incidents, failovers, expenses };
}
