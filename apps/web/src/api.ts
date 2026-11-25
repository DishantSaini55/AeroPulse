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

async function getJson<T>(path: string, allowUnavailable = false): Promise<T> {
  const response = await fetch(path, { signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok && !(allowUnavailable && response.status === 503 && result?.source === 'AVIATION_WEATHER_CENTER')) {
    throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
  }
  return result as T;
}

export const getSnapshot = () => getJson<Snapshot>('/api/v1/monitoring/snapshot');
export const getHistory = (code: string) => getJson<TelemetryHistory>(`/api/v1/devices/${encodeURIComponent(code)}/telemetry?limit=60`);
export const getWeather = () => getJson<Weather>('/api/v1/weather/vidp', true);
