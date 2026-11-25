import type { Database } from '../db.js';
import { TelemetryGenerator, type Scenario } from './generator.js';
import type { TelemetryBatchEvent } from '../realtime.js';

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
  ) {}

  // Internal scenario hook; administrator controls will be added in Phase 11.
  setScenario(deviceCode: string, scenario: Scenario) {
    this.scenarios.set(deviceCode, scenario);
  }

  setHeartbeatPaused(deviceCode: string, paused: boolean) {
    if (paused) this.pausedHeartbeats.add(deviceCode);
    else this.pausedHeartbeats.delete(deviceCode);
  }

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
      });
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
