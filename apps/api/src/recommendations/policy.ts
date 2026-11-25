import { createHash } from 'node:crypto';

export type RecommendationAction = 'CONTINUE_MONITORING' | 'PREVENTIVE_MAINTENANCE' | 'DETAILED_INVESTIGATION' | 'COMPONENT_REPLACEMENT' | 'EQUIPMENT_REPLACEMENT_REVIEW';
export type Policy = { windowDays: number; monitorAt: number; investigateAt: number; componentAt: number; replacementAt: number };
export type DeviceEvidence = { id: string; code: string; name: string; systemCode: string; commissionedAt: Date | null; latestReplacementAt: Date | null; latestReplacementCost: number | null };
export type FaultEvidence = { id: string; deviceId: string; rootCause: string | null; component: string; ruleCode: string; detectedAt: Date; resolvedAt: Date | null };
export type RepairEvidence = { id: string; deviceId: string; at: Date; cost: number };
export type RecommendationInput = { devices: DeviceEvidence[]; faults: FaultEvidence[]; repairs: RepairEvidence[] };

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
      const action: RecommendationAction = count >= policy.replacementAt ? 'EQUIPMENT_REPLACEMENT_REVIEW'
        : count >= policy.componentAt && (topComponent?.[1] ?? 0) >= policy.investigateAt ? 'COMPONENT_REPLACEMENT'
        : count >= policy.investigateAt ? 'DETAILED_INVESTIGATION'
        : count >= policy.monitorAt ? 'PREVENTIVE_MAINTENANCE' : 'CONTINUE_MONITORING';
      const causeKey = digest(cause);
      const evidenceHash = digest(JSON.stringify({ faults: sorted.map(item => [item.id, item.component, item.detectedAt.toISOString(), item.resolvedAt?.toISOString() ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), repairs: repairs.map(item => [item.id, item.cost]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), replacementAt: device.latestReplacementAt?.toISOString() ?? null, action, policy }));
      const downtimeIntervals = sorted.filter(item => item.ruleCode === 'MISSING_HEARTBEAT').map(item => ({ start: item.detectedAt.getTime(), end: (item.resolvedAt ?? at).getTime() })).sort((a, b) => a.start - b.start);
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
        downtimeMs,
        latestFailureAt: sorted.at(-1)!.detectedAt.toISOString(),
        rationale: `${count} confirmed ${count === 1 ? 'episode' : 'episodes'} for the same root cause in ${policy.windowDays} days since the latest unit replacement. ${count === 1 ? 'Inspect and repair the fault, then continue monitoring.' : count === 2 ? 'Monitor closely and schedule preventive maintenance.' : ''}`,
      });
    }
  }
  const rank: Record<RecommendationAction, number> = { EQUIPMENT_REPLACEMENT_REVIEW: 0, COMPONENT_REPLACEMENT: 1, DETAILED_INVESTIGATION: 2, PREVENTIVE_MAINTENANCE: 3, CONTINUE_MONITORING: 4 };
  return rows.sort((a, b) => rank[a.action] - rank[b.action] || b.similarFailures - a.similarFailures || a.deviceCode.localeCompare(b.deviceCode));
}
