import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';

export type RecommendationAction = 'CONTINUE_MONITORING' | 'PREVENTIVE_MAINTENANCE' | 'DETAILED_INVESTIGATION' | 'COMPONENT_REPLACEMENT' | 'EQUIPMENT_REPLACEMENT_REVIEW';
export type Policy = { windowDays: number; monitorAt: number; investigateAt: number; componentAt: number; replacementAt: number };
export type DeviceEvidence = { id: string; code: string; name: string; systemCode: string; commissionedAt: Date | null; latestReplacementAt: Date | null; latestReplacementCost: number | null };
export type FaultEvidence = { id: string; deviceId: string; rootCause: string | null; component: string; ruleCode: string; detectedAt: Date; resolvedAt: Date | null };
export type RepairEvidence = { id: string; deviceId: string; at: Date; cost: number };
export type MaintenanceEvidence = {
  id: string; deviceId: string; incidentId: string | null; type: string; status: string;
  updatedAt: Date; actualStartAt: Date | null; completedAt: Date | null; verified: boolean;
  findings: string | null; verificationResult: string | null; laborCost: string; otherCost: string;
  parts: { partName: string; quantity: number; unitCost: string }[];
};
export type RecommendationInput = { devices: DeviceEvidence[]; faults: FaultEvidence[]; repairs: RepairEvidence[]; maintenance?: MaintenanceEvidence[] };

const dayMs = 86_400_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const positiveInteger = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error('Recommendation policy values must be positive integers');
  return Number(value);
};

export function recommendationPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  const policy = {
    windowDays: positiveInteger(env.RECOMMENDATION_WINDOW_DAYS, 30),
    monitorAt: positiveInteger(env.RECOMMENDATION_MONITOR_AT, 2),
    investigateAt: positiveInteger(env.RECOMMENDATION_INVESTIGATE_AT, 3),
    componentAt: positiveInteger(env.RECOMMENDATION_COMPONENT_AT, 4),
    replacementAt: positiveInteger(env.RECOMMENDATION_REPLACEMENT_AT, 5),
  };
  if (policy.windowDays > 365 || !(1 < policy.monitorAt && policy.monitorAt < policy.investigateAt && policy.investigateAt < policy.componentAt && policy.componentAt < policy.replacementAt)) {
    throw new Error('Recommendation thresholds must increase and window must be 1–365 days');
  }
  return policy;
}

export function calculateRecommendations(input: RecommendationInput, at: Date, policy: Policy) {
  const from = new Date(at.getTime() - policy.windowDays * dayMs);
  const rows = [];
  for (const device of input.devices) {
    const cutoff = device.latestReplacementAt && device.latestReplacementAt > from ? device.latestReplacementAt : from;
    const faults = input.faults.filter(fault => fault.deviceId === device.id && fault.rootCause?.trim() && fault.detectedAt >= cutoff && fault.detectedAt <= at);
    const repairs = input.repairs.filter(repair => repair.deviceId === device.id && repair.at >= cutoff && repair.at <= at);
    const maintenance = (input.maintenance ?? []).filter(order => order.deviceId === device.id && order.status !== 'CANCELLED' &&
      (order.completedAt ?? order.updatedAt) >= cutoff && (order.completedAt ?? order.updatedAt) <= at);
    const completed = maintenance.filter(order => order.status === 'COMPLETED' && order.completedAt && order.verified);
    const corrective = completed.filter(order => order.type === 'CORRECTIVE');
    const maintenanceCost = maintenance.reduce((sum, order) => sum.plus(order.laborCost).plus(order.otherCost).plus(
      order.parts.reduce((parts, item) => parts.plus(new Prisma.Decimal(item.unitCost).mul(item.quantity)), new Prisma.Decimal(0))), new Prisma.Decimal(0)).toFixed(2);
    const partCounts = new Map<string, Set<string>>();
    for (const order of completed) for (const part of order.parts) {
      const name = part.partName.trim().toLocaleLowerCase('en-US');
      const records = partCounts.get(name) ?? new Set<string>(); records.add(order.id); partCounts.set(name, records);
    }
    const repeatedParts = [...partCounts].filter(([,records]) => records.size > 1).map(([part,records]) => ({ part, workOrders: records.size })).sort((a,b) => a.part.localeCompare(b.part));
    const repairCost = repairs.reduce((sum, repair) => sum + repair.cost, 0);
    const observationStart = device.latestReplacementAt ?? device.commissionedAt;
    const observedDays = observationStart ? Math.min(policy.windowDays, Math.max(0, (at.getTime() - Math.max(from.getTime(), observationStart.getTime())) / dayMs)) : null;
    const projected30DayRepairCost = observedDays != null && observedDays >= 7 ? Math.round(repairCost / observedDays * 30 * 100) / 100 : null;
    const ageStart = device.latestReplacementAt ?? device.commissionedAt;
    const equipmentAgeDays = ageStart ? Math.max(0, Math.floor((at.getTime() - ageStart.getTime()) / dayMs)) : null;
    const byCause = new Map<string, FaultEvidence[]>();
    for (const fault of faults) {
      const key = fault.rootCause!.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
      byCause.set(key, [...(byCause.get(key) ?? []), fault]);
    }
    for (const [cause, matches] of byCause) {
      const sorted = [...matches].sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
      // A single physical episode can trigger multiple diagnostic rules.
      const episodes: FaultEvidence[][] = [];
      for (const fault of sorted) {
        const previous = episodes.at(-1);
        const previousEnd = previous?.reduce((latest, item) => Math.max(latest, (item.resolvedAt ?? at).getTime()), 0) ?? 0;
        if (previous && fault.detectedAt.getTime() <= previousEnd + 30_000) previous.push(fault);
        else episodes.push([fault]);
      }
      const count = episodes.length;
      const componentCounts = new Map<string, number>();
      for (const episode of episodes) {
        for (const component of new Set(episode.map(item => item.component))) componentCounts.set(component, (componentCounts.get(component) ?? 0) + 1);
      }
      const topComponent = [...componentCounts].sort((a, b) => b[1] - a[1])[0];
      const latestCorrectiveAt = corrective.reduce<Date | null>((latest, order) => !latest || order.completedAt! > latest ? order.completedAt : latest, null);
      const failuresAfterCorrective = latestCorrectiveAt ? episodes.filter(episode => episode[0]!.detectedAt > latestCorrectiveAt).length : 0;
      const action: RecommendationAction = count >= policy.replacementAt ? 'EQUIPMENT_REPLACEMENT_REVIEW'
        : count >= policy.componentAt && (topComponent?.[1] ?? 0) >= policy.investigateAt ? 'COMPONENT_REPLACEMENT'
        : count >= policy.investigateAt || failuresAfterCorrective >= 2 ? 'DETAILED_INVESTIGATION'
        : count >= policy.monitorAt ? 'PREVENTIVE_MAINTENANCE' : 'CONTINUE_MONITORING';
      const causeKey = digest(cause);
      const evidenceHash = digest(JSON.stringify({ faults: sorted.map(item => [item.id, item.component, item.detectedAt.toISOString(), item.resolvedAt?.toISOString() ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), repairs: repairs.map(item => [item.id, item.cost]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), maintenance: maintenance.map(order => ({ ...order, parts: [...order.parts].sort((a,b) => a.partName.localeCompare(b.partName) || a.quantity-b.quantity || a.unitCost.localeCompare(b.unitCost)) })).sort((a,b) => a.id.localeCompare(b.id)), replacementAt: device.latestReplacementAt?.toISOString() ?? null, action, policy }));
      let downtimeIntervals = sorted.filter(item => item.ruleCode === 'MISSING_HEARTBEAT').map(item => ({ start: item.detectedAt.getTime(), end: (item.resolvedAt ?? at).getTime() }));
      for (const order of input.maintenance ?? []) if (order.deviceId === device.id && order.actualStartAt && ['PREVENTIVE','INSPECTION'].includes(order.type)) {
        const start = order.actualStartAt.getTime(), end = (order.completedAt ?? at).getTime();
        downtimeIntervals = downtimeIntervals.flatMap(interval => interval.end <= start || interval.start >= end ? [interval] :
          [{ start: interval.start, end: Math.min(start, interval.end) }, { start: Math.max(end, interval.start), end: interval.end }].filter(item => item.end > item.start));
      }
      downtimeIntervals.sort((a,b) => a.start-b.start);
      let downtimeMs = 0;
      let latestEnd = 0;
      for (const interval of downtimeIntervals) {
        downtimeMs += Math.max(0, interval.end - Math.max(interval.start, latestEnd));
        latestEnd = Math.max(latestEnd, interval.end);
      }
      rows.push({ deviceId: device.id, deviceCode: device.code, deviceName: device.name, systemCode: device.systemCode,
        rootCause: matches[0]!.rootCause!.trim(), causeKey, evidenceHash, action, similarFailures: count,
        component: topComponent?.[0] ?? 'Unknown', componentFailures: topComponent?.[1] ?? 0,
        repairCount: repairs.length, repairCost, latestReplacementCost: device.latestReplacementCost,
        projected30DayRepairCost, equipmentAgeDays,
        maintenance: { workOrders: maintenance.length, verifiedCompletions: completed.length, correctiveCompletions: corrective.length,
          expenditure: maintenanceCost, repeatedParts, failuresAfterCorrective, latestCorrectiveAt: latestCorrectiveAt?.toISOString() ?? null,
          linkedIncidentIds: [...new Set(maintenance.map(order => order.incidentId).filter((id): id is string => !!id))].sort(),
          costNote: 'Maintenance work-order expenditure is shown separately from incident repair costs; linked records may overlap and are not added together.',
          outcomes: maintenance.map(order => ({ workOrderId: order.id, type: order.type, status: order.status, verified: order.verified,
            completedAt: order.completedAt?.toISOString() ?? null, findings: order.findings, verificationResult: order.verificationResult })) },
        downtimeMs,
        latestFailureAt: sorted.at(-1)!.detectedAt.toISOString(),
        rationale: `${count} confirmed ${count === 1 ? 'episode' : 'episodes'} for the same root cause in ${policy.windowDays} days since the latest unit replacement. ${count === 1 ? 'Inspect and repair the fault, then continue monitoring.' : count === 2 && failuresAfterCorrective < 2 ? 'Monitor closely and schedule preventive maintenance.' : ''} ${corrective.length} verified corrective completions; ${failuresAfterCorrective} same-cause episodes after the latest verified corrective completion. ${failuresAfterCorrective >= 2 ? 'Repeated failures after corrective maintenance require detailed investigation.' : ''} Preventive work and expenditure alone do not count as failures or justify replacement.`,
      });
    }
  }
  const rank: Record<RecommendationAction, number> = { EQUIPMENT_REPLACEMENT_REVIEW: 0, COMPONENT_REPLACEMENT: 1, DETAILED_INVESTIGATION: 2, PREVENTIVE_MAINTENANCE: 3, CONTINUE_MONITORING: 4 };
  return rows.sort((a, b) => rank[a.action] - rank[b.action] || b.similarFailures - a.similarFailures || a.deviceCode.localeCompare(b.deviceCode));
}
