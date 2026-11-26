import { getToken, type User, type UserRole } from './auth';

export type Telemetry = {
  id: string;
  recordedAt: string;
  temperatureC: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  latencyMs: number | null;
  packetLossPct: number | null;
  voltageV: number | null;
  currentA: number | null;
  fanRpm: number | null;
  batteryPct: number | null;
  signalPct: number | null;
  simulated: boolean;
};

export type Device = {
  id: string;
  code: string;
  name: string;
  role: 'PRIMARY' | 'SECONDARY';
  health: string;
  activationState: string;
  system: { code: string; name: string; availability: string };
  latestTelemetry: Telemetry | null;
  latestHeartbeatAt: string | null;
};

export type Snapshot = { recordedAt: string; simulated: true; data: Device[] };
export type TelemetryHistory = {
  deviceCode: string;
  data: Telemetry[];
  page: number;
  limit: number;
  total: number;
  latestHeartbeatAt: string | null;
  simulated: true;
};
export type Weather = {
  source: 'AVIATION_WEATHER_CENTER';
  station: string;
  simulated: false;
  stale: boolean;
  staleReasons: string[];
  lastError: string | null;
  data: null | {
    observedAt: string;
    fetchedAt: string;
    rawMetar: string;
    temperatureC: number | null;
    dewPointC: number | null;
    visibilityMiles: number | null;
    windSpeedKnots: number | null;
    windDirectionDeg: number | null;
    pressureHpa: number | null;
    conditions: string | null;
  };
};

async function getJson<T>(path: string, allowUnavailable = false, timeoutMs = 10000): Promise<T> {
  const token = getToken();
  const response = await fetch(path, { signal: AbortSignal.timeout(timeoutMs), headers: token ? { authorization: `Bearer ${token}` } : {} });
  const result = await response.json();
  if (response.status === 401) window.dispatchEvent(new Event('aeropulse:unauthorized'));
  if (!response.ok && !(allowUnavailable && response.status === 503 && result?.source === 'AVIATION_WEATHER_CENTER')) {
    throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
  }
  return result as T;
}

export const getSnapshot = () => getJson<Snapshot>('/api/v1/monitoring/snapshot');
export const getHistory = (code: string) => getJson<TelemetryHistory>(`/api/v1/devices/${encodeURIComponent(code)}/telemetry?limit=60`);
export const getWeather = () => getJson<Weather>('/api/v1/weather/vidp', true);
export type Redundancy = {
  recordedAt: string;
  simulated: true;
  policy: { expectedIntervalMs: number; missedHeartbeatLimit: number; timeoutMs: number };
  data: {
    id: string; code: string; name: string; availability: 'AVAILABLE' | 'DEGRADED' | 'OUTAGE';
    activeDeviceCode: string | null; standbyReady: boolean;
    lastFailover: { id: string; action: 'AUTOMATIC_FAILOVER' | 'MANUAL_FAILBACK'; result: 'SUCCESS' | 'NO_HEALTHY_STANDBY' | 'BLOCKED'; detectedAt: string; durationMs: number; reason: string } | null;
    devices: { id: string; code: string; name: string; role: 'PRIMARY' | 'SECONDARY'; health: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'RECOVERING'; activationState: 'ACTIVE' | 'STANDBY' | 'INELIGIBLE'; latestHeartbeatAt: string | null; heartbeatPaused: boolean }[];
  }[];
};
export const getRedundancy = () => getJson<Redundancy>('/api/v1/redundancy');
export type FailoverEvent = { id: string; action: 'AUTOMATIC_FAILOVER' | 'MANUAL_FAILBACK'; result: 'SUCCESS' | 'NO_HEALTHY_STANDBY' | 'BLOCKED'; reason: string; detectedAt: string; completedAt: string; durationMs: number; system: { code: string; name: string }; fromDevice: { code: string } | null; toDevice: { code: string } | null; initiatedBy: { name: string } | null };
export const getFailoverEvents = async () => (await getJson<{ data: FailoverEvent[] }>('/api/v1/failover-events?limit=30')).data;

async function postAction(path: string, body: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` }, body: JSON.stringify(body) });
  const result = await response.json();
  if (response.status === 401) window.dispatchEvent(new Event('aeropulse:unauthorized'));
  if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
  return result.data;
}
export const setHeartbeatPaused = (code: string, paused: boolean) => postAction(`/api/v1/simulation/devices/${encodeURIComponent(code)}/heartbeat`, { paused });
export const requestFailback = (systemCode: string) => postAction(`/api/v1/systems/${encodeURIComponent(systemCode)}/failback`, {});

export type Diagnosis = { id: string; ruleCode: string; suspectedCause: string; component: string; severity: string; symptoms: string[]; supportingTelemetry: Record<string, number>; serviceImpact: string; investigationSteps: string[]; recoveryAction: string; detectedAt: string; lastSeenAt: string; resolvedAt: string | null; confirmedRootCause: string | null; confirmedAt: string | null; confirmedBy: { name: string } | null; previousSimilarFailures: number; device: { code: string; name: string; system: { code: string; name: string; availability: string } } };
export const getDiagnoses = async (active: 'all' | 'true' | 'false') => (await getJson<{ data: Diagnosis[] }>(`/api/v1/diagnoses?limit=100${active === 'all' ? '' : `&active=${active}`}`)).data;
export type SimulatedDevice = { code: string; name: string; role: string; system: { code: string; name: string }; scenario: string; heartbeatPaused: boolean };
export const getSimulationDevices = async () => (await getJson<{ data: SimulatedDevice[] }>('/api/v1/simulation/devices')).data;
export const setDeviceScenario = (code: string, scenario: string) => postAction(`/api/v1/simulation/devices/${encodeURIComponent(code)}/scenario`, { scenario });
export const setSystemScenario = (code: string, scenario: string) => postAction(`/api/v1/simulation/systems/${encodeURIComponent(code)}/scenario`, { scenario });
export async function confirmDiagnosis(id: string, rootCause: string) {
  const response = await fetch(`/api/v1/diagnoses/${encodeURIComponent(id)}/confirm`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` }, body: JSON.stringify({ rootCause }) });
  const result = await response.json();
  if (response.status === 401) window.dispatchEvent(new Event('aeropulse:unauthorized'));
  if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
  return result.data as Diagnosis;
}
export type Alarm = { id: string; sourceKey: string; level: 'INFORMATION' | 'WARNING' | 'MAJOR' | 'CRITICAL'; initialLevel: string; message: string; createdAt: string; resolvedAt: string | null; acknowledged: boolean; acknowledgedByMe: boolean; acknowledgedAt: string | null; acknowledgedBy: string | null; device: { code: string; name: string; role: string; system: { code: string; name: string; availability: string; failover: { result: 'SUCCESS' | 'NO_HEALTHY_STANDBY' | 'BLOCKED'; toDevice: { code: string; name: string } | null } | null } }; diagnosis: { suspectedCause: string; confirmedRootCause: string | null; component: string; symptoms: string[]; supportingTelemetry: Record<string, number>; serviceImpact: string; investigationSteps: string[]; recoveryAction: string } | null };
export const getAlarms = async (active: 'true' | 'false' | 'all' = 'true') => (await getJson<{ data: Alarm[] }>(`/api/v1/alarms?limit=100${active === 'all' ? '' : `&active=${active}`}`)).data;
export const acknowledgeAlarm = (id: string) => postAction(`/api/v1/alarms/${encodeURIComponent(id)}/acknowledge`, {});

export type IncidentStatus = 'DETECTED' | 'ACKNOWLEDGED' | 'ASSIGNED' | 'UNDER_INVESTIGATION' | 'UNDER_REPAIR' | 'VERIFICATION' | 'RESOLVED';
export type Incident = {
  id: string; alarmId: string; deviceId: string; status: IncidentStatus; priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'; description: string;
  createdAt: string; updatedAt: string; resolvedAt: string | null; approvedAt: string | null; repairDurationMs?: number | null;
  assignedTo: { id: string; name: string } | null; approvedBy: { name: string } | null;
  device: { code: string; name: string; system: { code: string; name: string } };
  alarm: { level: string; message?: string; createdAt?: string; resolvedAt: string | null; diagnosis: { suspectedCause?: string; confirmedRootCause: string | null; component?: string; symptoms?: string[]; supportingTelemetry?: Record<string, number> } | null };
  _count?: { repairs: number };
  events?: { id: string; kind: string; detail: string; createdAt: string; actor: { name: string } | null }[];
  repairs?: { id: string; action: string; spareParts: string[]; cost: string; createdAt: string; actor: { name: string } }[];
};
export const getIncidents = async (status: 'open' | 'resolved' | 'all', device?: string) => (await getJson<{ data: Incident[] }>(`/api/v1/incidents?status=${status}&limit=100${device ? `&device=${encodeURIComponent(device)}` : ''}`)).data;
export const getIncident = async (id: string) => (await getJson<{ data: Incident }>(`/api/v1/incidents/${encodeURIComponent(id)}`)).data;
export const getEngineers = async () => (await getJson<{ data: { id: string; name: string }[] }>('/api/v1/incidents/engineers')).data;
export const transitionIncident = (id: string, status: IncidentStatus, assignedToId?: string) => postAction(`/api/v1/incidents/${encodeURIComponent(id)}/transition`, { status, assignedToId });
export const approveIncident = (id: string) => postAction(`/api/v1/incidents/${encodeURIComponent(id)}/approve`, {});
export const commentIncident = (id: string, message: string) => postAction(`/api/v1/incidents/${encodeURIComponent(id)}/comments`, { message });
export const recordRepair = (id: string, action: string, spareParts: string[], cost: number) => postAction(`/api/v1/incidents/${encodeURIComponent(id)}/repairs`, { action, spareParts, cost });
export type DeviceReplacement = { id: string; oldUnitSerial: string; newUnitSerial: string; reason: string; cost: string; replacedAt: string; authorizedBy: { name: string } };
export type MaintenanceHistory = { device: { code: string; name: string; commissionedAt: string | null; system: { code: string; name: string } }; incidents: Incident[]; replacements: DeviceReplacement[]; failureCount: number; recordedRepairCost: number; replacementCost: number; equipmentDowntimeMs: number; serviceDowntimeMs: number };
export const getMaintenanceHistory = async (code: string) => (await getJson<{ data: MaintenanceHistory }>(`/api/v1/maintenance/${encodeURIComponent(code)}`)).data;
export type MaintenanceFilters = { device?: string; system?: string; from?: string; to?: string; severity?: string; rootCause?: string; page?: number };
export const getMaintenanceRecords = async (filters: MaintenanceFilters) => (await getJson<{ data: Incident[]; total: number; page: number; limit: number }>(`/api/v1/maintenance?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString()}`));
export const recordReplacement = (code: string, input: { oldUnitSerial: string; newUnitSerial: string; reason: string; cost: number; incidentId?: string }) => postAction(`/api/v1/maintenance/${encodeURIComponent(code)}/replacements`, input);

export type ReliabilityReport = {
  dataset: 'RECORDED' | 'HISTORICAL_DEMO'; from: string; to: string; deviceCount: number;
  coverage: { diagnoses: number; mttdSamples: number; mttaSamples: number; mttrSamples: number; mtbfIntervals: number; observedEquipmentMs: number; observedServiceMs: number };
  summary: { failureEpisodes: number; mttdMs: number | null; mttaMs: number | null; mttrMs: number | null; mtbfMs: number | null; equipmentAvailabilityPct: number | null; serviceAvailabilityPct: number | null; equipmentDowntimeMs: number; serviceDowntimeMs: number; recurringFaults: number; automaticFailovers: number; failoverSuccessPct: number | null; meanFailoverDurationMs: number | null; maintenanceCost: number };
  dailyTrends: { date: string; failures: number; maintenanceCost: number }[]; monthlyTrends: { month: string; failures: number }[];
  rootCauses: { label: string; count: number }[]; components: { label: string; count: number }[];
  systems: { code: string; observedMs: number; downtimeMs: number; availabilityPct: number | null; outageCount: number }[];
  devices: { code: string; systemCode: string; failureEpisodes: number; downtimeMs: number; observedMs: number; availabilityPct: number | null; recurringFaults: number; failuresPerObservedDay: number | null; maintenanceCost: number }[];
};
export const getReliability = async (dataset: 'recorded' | 'demo', days: 7 | 30 | 90) => getJson<{ data: ReliabilityReport; note: string; simulated: true }>(`/api/v1/analytics/reliability?dataset=${dataset}&days=${days}`, false, 20000);
export type AnalyticsTelemetry = { device: string; bucket: 'UTC_HOUR' | 'UTC_DAY'; data: { bucket: string; temperatureC: number | null; cpuPercent: number | null; packetLossPct: number | null }[]; simulated: true };
export const getAnalyticsTelemetry = (device: string, days: 7 | 30 | 90) => getJson<AnalyticsTelemetry>(`/api/v1/analytics/telemetry?device=${encodeURIComponent(device)}&days=${days}`, false, 20000);

export type RecommendationAction = 'CONTINUE_MONITORING' | 'PREVENTIVE_MAINTENANCE' | 'DETAILED_INVESTIGATION' | 'COMPONENT_REPLACEMENT' | 'EQUIPMENT_REPLACEMENT_REVIEW';
export type Recommendation = {
  deviceId: string; deviceCode: string; deviceName: string; systemCode: string; rootCause: string; causeKey: string; evidenceHash: string;
  action: RecommendationAction; similarFailures: number; component: string; componentFailures: number;
  repairCount: number; repairCost: number; latestReplacementCost: number | null; projected30DayRepairCost: number | null;
  equipmentAgeDays: number | null; downtimeMs: number; latestFailureAt: string; rationale: string;
  decision: { id: string; decision: 'APPROVED' | 'DECLINED'; note: string; decidedAt: string; decidedBy: { name: string } } | null;
};
export type RecommendationReport = { data: Recommendation[]; policy: { windowDays: number; monitorAt: number; investigateAt: number; componentAt: number; replacementAt: number }; generatedAt: string; simulated: true; note: string };
export const getRecommendations = () => getJson<RecommendationReport>('/api/v1/recommendations', false, 20000);
export const decideRecommendation = (item: Recommendation, decision: 'APPROVED' | 'DECLINED', note: string) => postAction('/api/v1/recommendations/decisions', { deviceId: item.deviceId, causeKey: item.causeKey, evidenceHash: item.evidenceHash, decision, note });

export type ReportType = 'incidents' | 'repairs' | 'replacements' | 'failovers' | 'audit';
export type ReportFilters = { type: ReportType; from: string; to: string; device?: string; system?: string };
export type OperationalReport = { type: ReportType; columns: string[]; rows: Record<string, string | number | null>[]; total: number; queryMs: number; generatedAt: string; from: string; to: string; simulated: true; note: string };
const reportQuery = (filters: ReportFilters, format: 'json' | 'csv') => new URLSearchParams(Object.entries({ ...filters, format }).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString();
export const getReport = (filters: ReportFilters) => getJson<OperationalReport>(`/api/v1/reports?${reportQuery(filters, 'json')}`, false, 20000);
export async function downloadReportCsv(filters: ReportFilters) {
  const response = await fetch(`/api/v1/reports?${reportQuery(filters, 'csv')}`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
  if (response.status === 401) window.dispatchEvent(new Event('aeropulse:unauthorized'));
  if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error?.message ?? `HTTP ${response.status}`); }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = `aeropulse-${filters.type}-${filters.from}-to-${filters.to}.csv`;
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
}
export type AuditEvent = { id: string; actorRole: string; method: string; path: string; statusCode: number; occurredAt: string; actor: { name: string; email: string } };
export type AuditFilters = { page: number; limit?: number; from?: string; to?: string; outcome?: 'all' | 'success' | 'failure' };
export const getAuditEvents = (filters: AuditFilters) => getJson<{ data: AuditEvent[]; total: number; page: number; limit: number; note: string }>(`/api/v1/audit-events?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString()}`);

export type ManagedUser = User & { createdAt: string };
export const getUsers = async () => (await getJson<{ data: ManagedUser[] }>('/api/v1/users')).data;

async function writeUser(path: string, method: 'POST' | 'PATCH', body: unknown) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (response.status === 401) window.dispatchEvent(new Event('aeropulse:unauthorized'));
  if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
  return result.data as ManagedUser;
}

export const createUser = (input: { email: string; name: string; password: string; role: UserRole }) => writeUser('/api/v1/users', 'POST', input);
export const updateUser = (id: string, input: { active?: boolean; role?: UserRole; name?: string }) => writeUser(`/api/v1/users/${encodeURIComponent(id)}`, 'PATCH', input);
