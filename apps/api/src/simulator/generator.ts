export type Scenario = 'NORMAL' | 'DEGRADATION' | 'FAILURE' | 'RECOVERY' | 'OVERHEATING' | 'FAN_FAILURE' | 'CPU_OVERLOAD' | 'MEMORY_OVERLOAD' | 'DISK_EXHAUSTION' | 'NETWORK_DISCONNECTION' | 'PACKET_LOSS' | 'POWER_FAILURE' | 'MISSING_HEARTBEAT';
export type Metrics = {
  temperatureC?: number | null;
  cpuPercent?: number | null;
  memoryPercent?: number | null;
  diskPercent?: number | null;
  latencyMs?: number | null;
  packetLossPct?: number | null;
  voltageV?: number | null;
  currentA?: number | null;
  fanRpm?: number | null;
  batteryPct?: number | null;
  signalPct?: number | null;
};

type DeviceState = { stress: number; drift: number; last: Metrics };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 10) / 10;

function profile(code: string) {
  const system = code.replace(/-[PS]$/, '');
  return {
    compute: ['AMSS', 'AUTOMATION', 'ASMGCS'].includes(system),
    network: ['NETWORK', 'AMSS', 'AUTOMATION', 'ASMGCS', 'RADAR', 'VHF', 'ILS', 'DME'].includes(system),
    power: system === 'UPS',
    cooling: system === 'COOLING',
    signal: ['RADAR', 'VHF', 'ILS', 'DME'].includes(system),
  };
}

// One seeded stream per device makes a run reproducible and independent of device order.
function seedFor(code: string) {
  let hash = 2166136261;
  for (const char of code) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export class TelemetryGenerator {
  private readonly states = new Map<string, DeviceState>();
  private readonly seeds = new Map<string, number>();

  private noise(code: string) {
    const next = (Math.imul(this.seeds.get(code) ?? seedFor(code), 1664525) + 1013904223) >>> 0;
    this.seeds.set(code, next);
    return next / 4294967296 - 0.5;
  }

  next(code: string, scenario: Scenario = 'NORMAL'): Metrics {
    const state = this.states.get(code) ?? { stress: 0, drift: 0, last: {} };
    const target = scenario === 'FAILURE' ? 1 : scenario === 'DEGRADATION' ? 0.55 : scenario === 'NORMAL' || scenario === 'RECOVERY' ? 0 : 0.35;
    const rate = scenario === 'RECOVERY' ? 0.35 : 0.22;
    state.stress += (target - state.stress) * rate;
    state.drift = clamp(state.drift + this.noise(code) * 0.8, -2, 2);
    const stress = state.stress;
    const p = profile(code);
    const smooth = (key: keyof Metrics, targetValue: number, min: number, max: number) => {
      const previous = state.last[key] ?? targetValue;
      return round(clamp(previous + (targetValue - previous) * 0.55, min, max));
    };
    const jitter = () => this.noise(code);
    const metrics: Metrics = {
      temperatureC: smooth('temperatureC', 31 + state.drift + 51 * stress + jitter() * 1.5, 0, 110),
      fanRpm: smooth('fanRpm', 2400 - 2050 * stress + jitter() * 60, 0, 4000),
    };
    if (p.compute) {
      metrics.cpuPercent = smooth('cpuPercent', 28 + 67 * stress + jitter() * 3, 0, 100);
      metrics.memoryPercent = smooth('memoryPercent', 36 + 59 * stress + jitter() * 2, 0, 100);
      metrics.diskPercent = smooth('diskPercent', 48 + 46 * stress + jitter(), 0, 100);
    }
    if (p.network) {
      metrics.latencyMs = smooth('latencyMs', 8 + 215 * stress + jitter() * 3, 0, 1000);
      metrics.packetLossPct = smooth('packetLossPct', 0.1 + 58 * stress + jitter() * 0.2, 0, 100);
    }
    if (p.power) {
      metrics.voltageV = smooth('voltageV', 230 - 95 * stress + jitter() * 2, 0, 300);
      metrics.currentA = smooth('currentA', 8 + 6 * stress + jitter() * 0.2, 0, 40);
      metrics.batteryPct = smooth('batteryPct', 94 - 70 * stress + jitter(), 0, 100);
    }
    if (p.cooling) {
      metrics.currentA = smooth('currentA', 6 + 3 * stress + jitter() * 0.2, 0, 40);
    }
    if (p.signal) {
      metrics.signalPct = smooth('signalPct', 96 - 82 * stress + jitter(), 0, 100);
    }
    if (scenario === 'OVERHEATING' || scenario === 'FAN_FAILURE') metrics.temperatureC = smooth('temperatureC', 88, 0, 110);
    if (scenario === 'FAN_FAILURE') metrics.fanRpm = smooth('fanRpm', 300, 0, 4000);
    if (scenario === 'CPU_OVERLOAD' && p.compute) { metrics.cpuPercent = smooth('cpuPercent', 96, 0, 100); metrics.memoryPercent = smooth('memoryPercent', 91, 0, 100); }
    if (scenario === 'MEMORY_OVERLOAD' && p.compute) metrics.memoryPercent = smooth('memoryPercent', 96, 0, 100);
    if (scenario === 'DISK_EXHAUSTION' && p.compute) metrics.diskPercent = smooth('diskPercent', 97, 0, 100);
    if ((scenario === 'NETWORK_DISCONNECTION' || scenario === 'PACKET_LOSS') && p.network) { metrics.latencyMs = smooth('latencyMs', 260, 0, 1000); metrics.packetLossPct = smooth('packetLossPct', 55, 0, 100); }
    if (scenario === 'POWER_FAILURE' && p.power) metrics.voltageV = smooth('voltageV', 150, 0, 300);
    state.last = metrics;
    this.states.set(code, state);
    return metrics;
  }
}
