import type { Database } from '../db.js';
import { TelemetryGenerator, type Scenario } from './generator.js';
import type { SimulatorControl, TelemetryBatchEvent } from '../realtime.js';

const INTERVAL_MS = 5000;

export class TelemetrySimulator {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private pending?: Promise<boolean>;
  private readonly generator = new TelemetryGenerator();
  private readonly scenarios = new Map<string, Scenario>();
  private readonly pausedHeartbeats = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly intervalMs = INTERVAL_MS,
    private readonly onBatch?: (event: TelemetryBatchEvent) => void,
    private readonly onControl?: (control: SimulatorControl) => void,
  ) {}

  setScenario(deviceCode: string, scenario: Scenario) {
    this.applyControl({ kind: 'SCENARIO', deviceCode, scenario });
    this.onControl?.({ kind: 'SCENARIO', deviceCode, scenario });
  }

  setHeartbeatPaused(deviceCode: string, paused: boolean) {
    this.applyControl({ kind: 'HEARTBEAT', deviceCode, paused });
    this.onControl?.({ kind: 'HEARTBEAT', deviceCode, paused });
  }

  applyControl(control: SimulatorControl) {
    if (control.kind === 'HEARTBEAT') {
      if (control.paused) this.pausedHeartbeats.add(control.deviceCode);
      else this.pausedHeartbeats.delete(control.deviceCode);
      return;
    }
    const scenario = control.scenario as Scenario;
    const deviceCode = control.deviceCode;
    this.scenarios.set(deviceCode, scenario);
    if (scenario === 'MISSING_HEARTBEAT' || scenario === 'NETWORK_DISCONNECTION') this.pausedHeartbeats.add(deviceCode);
    else this.pausedHeartbeats.delete(deviceCode);
  }

  getScenario(deviceCode: string): Scenario { return this.scenarios.get(deviceCode) ?? 'NORMAL'; }

  isHeartbeatPaused(deviceCode: string) { return this.pausedHeartbeats.has(deviceCode); }

  async tick(at = new Date()) {
    if (this.running) return false;
    this.running = true;
    try {
      const devices = await this.db.device.findMany({ select: { id: true, code: true } });
      const readings = devices.map((device) => ({
        deviceId: device.id,
        recordedAt: at,
        ...this.generator.next(device.code, this.scenarios.get(device.code) ?? 'NORMAL'),
        simulated: true,
      }));
      await this.db.$transaction(async (transaction) => {
        await transaction.telemetryReading.createMany({ data: readings });
        await transaction.heartbeat.createMany({
          data: devices.filter(device => !this.pausedHeartbeats.has(device.code)).map((device) => ({ deviceId: device.id, recordedAt: at, simulated: true })),
        });
      }, { maxWait: 15000, timeout: 30000 });
      try {
        this.onBatch?.({ recordedAt: at.toISOString(), deviceCodes: devices.map(device => device.code), simulated: true });
      } catch (error) {
        console.error('Telemetry broadcast failed', error);
      }
      return true;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    this.scheduleTick();
    this.timer = setInterval(() => {
      this.scheduleTick();
    }, this.intervalMs);
  }

  private scheduleTick() {
    if (this.pending) return;
    this.pending = this.tick().catch((error: unknown) => {
      console.error('Telemetry tick failed', error);
      return false;
    }).finally(() => { this.pending = undefined; });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
