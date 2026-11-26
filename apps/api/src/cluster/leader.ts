import { randomUUID } from 'node:crypto';
import { connectInBackground, createResilientRedisClient } from './redis.js';

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
  constructor(
    private readonly client: LeaseClient,
    private readonly key: string,
    private readonly ttlMs: number,
    private readonly renewEveryMs: number,
    private readonly handlers: LeadershipHandlers,
    private readonly available: () => boolean = () => true,
  ) {}

  async start() {
    if (this.available()) await this.reconcile();
    this.timer = setInterval(() => { void this.reconcile(); }, this.renewEveryMs);
  }
  isLeader() { return this.leader; }
  async dependencyUnavailable() { await this.becomeFollower(); }
  async dependencyAvailable() { await this.reconcile(); }

  private async reconcile() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run() {
    if (!this.available()) { await this.becomeFollower(); return; }
    let owns = false;
    try {
      if (this.leader) owns = Number(await this.client.eval(renewScript, { keys: [this.key], arguments: [this.token, String(this.ttlMs)] })) === 1;
      else owns = (await this.client.set(this.key, this.token, { NX: true, PX: this.ttlMs })) === 'OK';
    } catch (error) {
      console.error('Leader lease operation failed', error);
      await this.becomeFollower();
      return;
    }
    if (owns === this.leader) return;
    if (owns) {
      this.leader = true;
      try { await this.handlers.onLeader(); }
      catch (error) {
        console.error('Leader job startup failed', error);
        await this.becomeFollower();
      }
      return;
    }
    await this.becomeFollower();
  }

  private async becomeFollower() {
    if (!this.leader) return;
    this.leader = false;
    try { await this.handlers.onFollower(); }
    catch (error) { console.error('Follower job shutdown failed', error); }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    if (this.leader) {
      try { await this.client.eval(releaseScript, { keys: [this.key], arguments: [this.token] }); }
      catch (error) { console.error('Leader lease release failed', error); }
    }
    await this.becomeFollower();
    try { await this.client.quit(); }
    catch (error) { console.error('Leader Redis shutdown failed', error); }
  }
}

export async function startLeadership(redisUrl: string | undefined, handlers: LeadershipHandlers) {
  if (!redisUrl) { await handlers.onLeader(); return { isLeader: () => true, isAvailable: () => true, stop: handlers.onFollower }; }
  const connection = createResilientRedisClient(redisUrl, 'leader-lease');
  const client = connection.client;
  const ttlMs = Number(process.env.LEADER_LOCK_TTL_MS ?? 10_000);
  const renewEveryMs = Number(process.env.LEADER_RENEW_MS ?? 3_000);
  if (!Number.isInteger(ttlMs) || ttlMs < 3_000 || !Number.isInteger(renewEveryMs) || renewEveryMs < 500 || renewEveryMs >= ttlMs) throw new Error('Invalid leader lock timing');
  const elector = new LeaderElector(client, process.env.LEADER_LOCK_KEY ?? 'aeropulse:leader', ttlMs, renewEveryMs, handlers, () => connection.health.isReady());
  connection.health.subscribe(state => {
    if (state === 'ready') void elector.dependencyAvailable();
    else if (state !== 'connecting') void elector.dependencyUnavailable();
  });
  connectInBackground(client, connection.health, 'leader-lease');
  await elector.start();
  return { isLeader: () => elector.isLeader(), isAvailable: () => connection.health.isReady(), stop: () => elector.stop() };
}
