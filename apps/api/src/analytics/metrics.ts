export type AnalyticsDevice = { id: string; code: string; systemCode: string; healthyObservedMs: number };
export type AnalyticsDiagnosis = { deviceId: string; ruleCode: string; component: string; confirmedRootCause: string | null; firstObservedAt: Date | null; detectedAt: Date; resolvedAt: Date | null };
export type AnalyticsOutage = { systemCode: string; createdAt: Date; resolvedAt: Date | null };
export type AnalyticsIncident = { deviceId: string; createdAt: Date; acknowledgedAt: Date | null; repairStartedAt: Date | null; repairCompletedAt: Date | null };
export type AnalyticsFailover = { systemCode: string; result: string; durationMs: number; detectedAt: Date };
export type AnalyticsExpense = { deviceId: string; at: Date; amount: number; kind: 'REPAIR' | 'REPLACEMENT' };
export type AnalyticsInput = {
  devices: AnalyticsDevice[]; diagnoses: AnalyticsDiagnosis[]; outages: AnalyticsOutage[];
  incidents: AnalyticsIncident[]; failovers: AnalyticsFailover[]; expenses: AnalyticsExpense[];
  plannedMaintenance?: Array<{ deviceId: string; start: Date; end: Date | null }>;
};

type Interval = { start: number; end: number };
const dayMs = 86_400_000;
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const percent = (good: number, total: number) => total > 0 ? Math.max(0, Math.min(100, good / total * 100)) : null;
const utcDay = (at: Date) => at.toISOString().slice(0, 10);
const utcMonth = (at: Date) => at.toISOString().slice(0, 7);

function merge(intervals: Interval[], gapMs = 0) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const result: Interval[] = [];
  for (const item of sorted) {
    const previous = result.at(-1);
    if (previous && item.start <= previous.end + gapMs) previous.end = Math.max(previous.end, item.end);
    else result.push({ ...item });
  }
  return result;
}

function overlapMs(intervals: Interval[], from: number, to: number) {
  return merge(intervals.map(item => ({ start: Math.max(item.start, from), end: Math.min(item.end, to) })).filter(item => item.end > item.start))
    .reduce((sum, item) => sum + item.end - item.start, 0);
}

function counts(items: string[]) {
  const result = new Map<string, number>();
  for (const item of items) result.set(item, (result.get(item) ?? 0) + 1);
  return [...result].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function calculateReliability(input: AnalyticsInput, from: Date, to: Date, dataset: 'RECORDED' | 'HISTORICAL_DEMO') {
  const start = from.getTime();
  const end = to.getTime();
  if (!(end > start)) throw new Error('Invalid analytics window');
  const windowMs = end - start;
  const systems = [...new Set(input.devices.map(device => device.systemCode))].sort();
  const episodesByDevice = new Map<string, Interval[]>();
  const downtimeByDevice = new Map<string, number>();
  const availabilityByDevice = new Map<string, number | null>();
  const observedMsByDevice = new Map<string, number>();
  for (const device of input.devices) {
    const findings = input.diagnoses.filter(item => item.deviceId === device.id);
    const episodes = merge(findings.map(item => ({ start: item.detectedAt.getTime(), end: (item.resolvedAt ?? to).getTime() })), 30_000);
    episodesByDevice.set(device.id, episodes);
    const downtime = overlapMs(findings.filter(item => item.ruleCode === 'MISSING_HEARTBEAT').map(item => ({ start: item.detectedAt.getTime(), end: (item.resolvedAt ?? to).getTime() })), start, end);
    const observedMs = Math.min(windowMs, Math.max(0, device.healthyObservedMs) + downtime);
    observedMsByDevice.set(device.id, observedMs);
    downtimeByDevice.set(device.id, downtime);
    availabilityByDevice.set(device.id, percent(observedMs - downtime, observedMs));
  }
  const systemRows = systems.map(code => {
    const members = input.devices.filter(device => device.systemCode === code);
    const outages = input.outages.filter(item => item.systemCode === code);
    const downtimeMs = overlapMs(outages.map(item => ({ start: item.createdAt.getTime(), end: (item.resolvedAt ?? to).getTime() })), start, end);
    const healthyObservedMs = members.reduce((largest, device) => Math.max(largest, device.healthyObservedMs), 0);
    const observedMs = Math.min(windowMs, healthyObservedMs + downtimeMs);
    return { code, observedMs, downtimeMs, availabilityPct: percent(observedMs - downtimeMs, observedMs), outageCount: outages.filter(item => item.createdAt >= from && item.createdAt <= to).length };
  });
  const episodeStarts = [...episodesByDevice.values()].flatMap(items => items.filter(item => item.start >= start && item.start <= end).map(item => item.start));
  const mtbfSamples = [...episodesByDevice.values()].flatMap(items => items.slice(1).map((item, index) => item.start - items[index]!.end).filter(value => value > 0));
  const mttdSamples = input.diagnoses.filter(item => item.firstObservedAt && item.detectedAt >= from && item.detectedAt <= to && item.firstObservedAt <= item.detectedAt)
    .map(item => item.detectedAt.getTime() - item.firstObservedAt!.getTime());
  const mttaSamples = input.incidents.filter(item => item.acknowledgedAt && item.createdAt >= from && item.createdAt <= to && item.acknowledgedAt >= item.createdAt)
    .map(item => item.acknowledgedAt!.getTime() - item.createdAt.getTime());
  const mttrSamples = input.incidents.filter(item => item.repairStartedAt && item.repairCompletedAt && item.repairCompletedAt >= from && item.repairCompletedAt <= to && item.repairCompletedAt >= item.repairStartedAt)
    .map(item => item.repairCompletedAt!.getTime() - item.repairStartedAt!.getTime());
  const automatic = input.failovers.filter(item => item.detectedAt >= from && item.detectedAt <= to);
  const successful = automatic.filter(item => item.result === 'SUCCESS');
  const recurrentByDevice = new Map<string, number>();
  const repeatedRules = new Map<string, number>();
  for (const finding of input.diagnoses.filter(item => item.detectedAt >= from && item.detectedAt <= to)) {
    const key = `${finding.deviceId}:${finding.ruleCode}`;
    repeatedRules.set(key, (repeatedRules.get(key) ?? 0) + 1);
  }
  for (const [key, count] of repeatedRules) if (count > 1) {
    const deviceId = key.split(':')[0]!;
    recurrentByDevice.set(deviceId, (recurrentByDevice.get(deviceId) ?? 0) + count - 1);
  }
  const deviceRows = input.devices.map(device => {
    const episodes = episodesByDevice.get(device.id) ?? [];
    const observedMs = observedMsByDevice.get(device.id) ?? 0;
    const count = episodes.filter(item => item.start >= start && item.start <= end).length;
    return { code: device.code, systemCode: device.systemCode, failureEpisodes: count, downtimeMs: downtimeByDevice.get(device.id) ?? 0,
      observedMs, availabilityPct: availabilityByDevice.get(device.id) ?? null, recurringFaults: recurrentByDevice.get(device.id) ?? 0,
      failuresPerObservedDay: observedMs >= dayMs ? count / (observedMs / dayMs) : null,
      maintenanceCost: input.expenses.filter(item => item.deviceId === device.id && item.at >= from && item.at <= to).reduce((sum, item) => sum + item.amount, 0) };
  }).sort((a, b) => (a.availabilityPct ?? 101) - (b.availabilityPct ?? 101) || b.failureEpisodes - a.failureEpisodes || a.code.localeCompare(b.code));
  const daily = new Map<string, { date: string; failures: number; maintenanceCost: number }>();
  for (let at = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); at <= end; at += dayMs) {
    const date = utcDay(new Date(at)); daily.set(date, { date, failures: 0, maintenanceCost: 0 });
  }
  for (const at of episodeStarts) { const row = daily.get(utcDay(new Date(at))); if (row) row.failures++; }
  for (const item of input.expenses.filter(item => item.at >= from && item.at <= to)) { const row = daily.get(utcDay(item.at)); if (row) row.maintenanceCost += item.amount; }
  const monthly = counts(episodeStarts.map(at => utcMonth(new Date(at)))).map(item => ({ month: item.label, failures: item.count })).sort((a, b) => a.month.localeCompare(b.month));
  const observedEquipmentMs = [...observedMsByDevice.values()].reduce((sum, value) => sum + value, 0);
  const equipmentDowntimeMs = [...downtimeByDevice.values()].reduce((sum, value) => sum + value, 0);
  const plannedEquipmentUnavailabilityMs = input.devices.reduce((total, device) => total + overlapMs(
    (input.plannedMaintenance ?? []).filter(item => item.deviceId === device.id).map(item => ({ start: item.start.getTime(), end: (item.end ?? to).getTime() })), start, end), 0);
  const observedServiceMs = systemRows.reduce((sum, row) => sum + row.observedMs, 0);
  const serviceDowntimeMs = systemRows.reduce((sum, row) => sum + row.downtimeMs, 0);
  const findingsInWindow = input.diagnoses.filter(item => item.detectedAt >= from && item.detectedAt <= to);
  return {
    dataset, from: from.toISOString(), to: to.toISOString(), deviceCount: input.devices.length,
    coverage: { diagnoses: findingsInWindow.length, mttdSamples: mttdSamples.length, mttaSamples: mttaSamples.length, mttrSamples: mttrSamples.length, mtbfIntervals: mtbfSamples.length, observedEquipmentMs, observedServiceMs },
    summary: { failureEpisodes: episodeStarts.length, mttdMs: mean(mttdSamples), mttaMs: mean(mttaSamples), mttrMs: mean(mttrSamples), mtbfMs: mean(mtbfSamples),
      equipmentAvailabilityPct: percent(observedEquipmentMs - equipmentDowntimeMs, observedEquipmentMs), serviceAvailabilityPct: percent(observedServiceMs - serviceDowntimeMs, observedServiceMs),
      equipmentDowntimeMs, plannedEquipmentUnavailabilityMs, serviceDowntimeMs, recurringFaults: [...recurrentByDevice.values()].reduce((sum, value) => sum + value, 0),
      automaticFailovers: automatic.length, failoverSuccessPct: percent(successful.length, automatic.length), meanFailoverDurationMs: mean(successful.map(item => item.durationMs)),
      maintenanceCost: input.expenses.filter(item => item.at >= from && item.at <= to).reduce((sum, item) => sum + item.amount, 0) },
    dailyTrends: [...daily.values()], monthlyTrends: monthly,
    rootCauses: counts(findingsInWindow.map(item => item.confirmedRootCause ?? 'Unconfirmed')),
    components: counts(findingsInWindow.map(item => item.component)),
    systems: systemRows.sort((a, b) => b.downtimeMs - a.downtimeMs || a.code.localeCompare(b.code)), devices: deviceRows,
  };
}
