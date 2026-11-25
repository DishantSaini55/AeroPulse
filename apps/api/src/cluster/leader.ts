import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

type LeadershipHandlers = { onLeader: () => Promise<void>; onFollower: () => Promise<void> };
type LeaseClient = {
  set: (key: string, value: string, options: { NX: true; PX: number }) => Promise<string | null>;
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
  quit: () => Promise<unknown>;
};

const renewScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const releaseScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export class LeaderElector {
  private timer?: ReturnType<typeof setInterval>;
  private leader = false;
  private running?: Promise<void>;
  private readonly token = randomUUID();
  constructor(private readonly client: LeaseClient, private readonly key: string, private readonly ttlMs: number, private readonly renewEveryMs: number, private readonly handlers: LeadershipHandlers) {}

  async start() { await this.reconcile(); this.timer = setInterval(() => { void this.reconcile(); }, this.renewEveryMs); }
  isLeader() { return this.leader; }

  private async reconcile() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run() {
    let owns = false;
    if (this.leader) owns = Number(await this.client.eval(renewScript, { keys: [this.key], arguments: [this.token, String(this.ttlMs)] })) === 1;
    else owns = (await this.client.set(this.key, this.token, { NX: true, PX: this.ttlMs })) === 'OK';
    if (owns === this.leader) return;
    this.leader = owns;
    if (owns) await this.handlers.onLeader();
    else await this.handlers.onFollower();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    if (this.leader) {
      await this.client.eval(releaseScript, { keys: [this.key], arguments: [this.token] });
      this.leader = false;
      await this.handlers.onFollower();
    }
    await this.client.quit();
  }
}

export async function startLeadership(redisUrl: string | undefined, handlers: LeadershipHandlers) {
  if (!redisUrl) { await handlers.onLeader(); return { isLeader: () => true, stop: handlers.onFollower }; }
  const client = createClient({ url: redisUrl });
  await client.connect();
  const ttlMs = Number(process.env.LEADER_LOCK_TTL_MS ?? 10_000);
  const renewEveryMs = Number(process.env.LEADER_RENEW_MS ?? 3_000);
  if (!Number.isInteger(ttlMs) || ttlMs < 3_000 || !Number.isInteger(renewEveryMs) || renewEveryMs < 500 || renewEveryMs >= ttlMs) throw new Error('Invalid leader lock timing');
  const elector = new LeaderElector(client, process.env.LEADER_LOCK_KEY ?? 'aeropulse:leader', ttlMs, renewEveryMs, handlers);
  await elector.start();
  return elector;
}
