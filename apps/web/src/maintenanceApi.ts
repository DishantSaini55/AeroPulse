import { getToken } from './auth';

export async function maintenanceRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/v1/maintenance/' + path, { method, signal: AbortSignal.timeout(20000),
    headers: { authorization: 'Bearer ' + (getToken() ?? ''), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 401) window.dispatchEvent(new Event('aeropulse:unauthorized'));
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status} · ${result.error?.code ?? 'REQUEST_FAILED'}: ${result.error?.message ?? 'Request failed'}`);
  return result as T;
}
export type MaintenanceDevice = { id: string; code: string; name: string; systemId: string; role: string; health: string; activationState: string; maintenanceStatus: string; maintenanceEligible: boolean; system?: { code: string; name: string } };
export type Options = { devices: MaintenanceDevice[]; engineers: { id: string; name: string }[] };
export type Plan = { id: string; name: string; deviceId: string; category: string; description: string; checklist: string[]; frequency: string; customIntervalDays: number | null;
  advanceNoticeDays: number; estimatedDurationMinutes: number; priority: string; assignedEngineerId: string | null; active: boolean; nextScheduledAt: string };
export type Part = { id: string; partName: string; partNumber: string | null; quantity: number; unitCost: string };
export type WorkOrder = { id: string; title: string; deviceId: string; systemId: string; planId: string | null; type: string; priority: string; description: string; status: string;
  assignedEngineerId: string | null; maintenanceModeAt: string | null; findings: string | null; verificationResult: string | null;
  scheduledStartAt: string | null; scheduledCompletionAt: string | null; actualStartAt: string | null; completedAt: string | null; createdAt: string;
  estimatedDurationMinutes: number; laborCost: string; otherCost: string; device?: { code: string }; assignedEngineer?: { name: string };
  checklistItems?: { id: string; description: string; completed: boolean; result: string | null; remarks: string | null; completedAt: string | null }[];
  parts?: Part[]; transitions?: { id: string; fromStatus: string | null; toStatus: string; createdAt: string; note: string | null }[] };
export type Costs = { parts: number; labor: number; other: number; total: number };
export type Readiness = { canStart: boolean; blockingReasons: string[]; plannedSwitch: boolean; standbyCode: string | null; checkedAt: string; policy: { timeoutMs: number };
  devices: (MaintenanceDevice & { latestHeartbeatAt: string | null; heartbeatFresh: boolean })[] };
export type Overview = { from: string; to: string; generatedAt: string; devicesUnderMaintenance: number; upcoming: number; overdue: number; upcomingPlans: number; overduePlans: number; active: number; completed: number;
  compliance: { numerator: number; denominator: number; percent: number | null }; averageCompletionMs: number | null; completionSamples: number; totalExpenditure: string;
  distribution: { preventive: number; corrective: number; other: number }; engineerWorkload: { id: string; name: string; active: number; completed: number }[];
  expenditureByDevice: { code: string; amount: string }[]; expenditureBySystem: { code: string; amount: string }[];
  plannedEquipmentDowntimeMs: number; unplannedEquipmentDowntimeMs: number; serviceAvailabilityPct: number | null; serviceObservedMs: number; formulas: Record<string, string> };
export const orderStatuses = ['DRAFT','SCHEDULED','ASSIGNED','IN_PROGRESS','ON_HOLD','VERIFICATION','COMPLETED','CANCELLED','REJECTED'];
export const orderTypes = ['PREVENTIVE','CORRECTIVE','INSPECTION','COMPONENT_REPLACEMENT','EQUIPMENT_REPLACEMENT'];
export const useOptionsQuery = { queryKey: ['maintenance', 'options'], queryFn: async () => (await maintenanceRequest<{ data: Options }>('options')).data, staleTime: 30000 };
