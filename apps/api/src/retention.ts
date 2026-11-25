import type { Database } from './db.js';

const dayMs = 86_400_000;

export function telemetryRetentionDays(value = process.env.TELEMETRY_RETENTION_DAYS) {
  if (value === undefined || value === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3_650) throw new Error('TELEMETRY_RETENTION_DAYS must be an integer from 1 to 3650');
  return days;
}

export class RetentionService {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  constructor(private readonly db: Database, private readonly days: number | null, private readonly now: () => Date = () => new Date()) {}

  async run() {
    if (this.days === null || this.pending) return this.pending;
    const cutoff = new Date(this.now().getTime() - this.days * dayMs);
    this.pending = this.db.$transaction(async tx => {
      const [telemetry, heartbeats] = await Promise.all([
        tx.telemetryReading.deleteMany({ where: { recordedAt: { lt: cutoff } } }),
        tx.heartbeat.deleteMany({ where: { recordedAt: { lt: cutoff } } }),
      ]);
      console.info(JSON.stringify({ level: 'info', event: 'telemetry_retention', cutoff: cutoff.toISOString(), telemetryDeleted: telemetry.count, heartbeatsDeleted: heartbeats.count }));
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  start() {
    if (this.days === null || this.timer) return;
    void this.run().catch(error => console.error('Telemetry retention failed', error));
    this.timer = setInterval(() => { void this.run().catch(error => console.error('Telemetry retention failed', error)); }, dayMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
