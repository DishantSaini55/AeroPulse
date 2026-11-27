import type { MaintenanceService } from './service.js';

export class MaintenanceScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private enabled = false;
  constructor(private readonly service: Pick<MaintenanceService, 'generateDue'>, private readonly intervalMs = 30_000,
    private readonly eligible: () => boolean = () => true, private readonly onGenerated?: () => void) {
    if (!Number.isInteger(intervalMs) || intervalMs < 10) throw new Error('Invalid maintenance scheduler interval');
  }
  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }
  private tick() {
    if (!this.enabled || !this.eligible() || this.pending) return;
    this.pending = this.service.generateDue(new Date(), () => this.enabled && this.eligible())
      .then(count => { if (count) this.onGenerated?.(); })
      .catch(error => console.error('Maintenance scheduling failed', error))
      .finally(() => { this.pending = undefined; });
  }
  async stop() {
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
