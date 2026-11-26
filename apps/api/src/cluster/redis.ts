import { createClient } from 'redis';

export type RedisConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'unavailable' | 'closed';

export type RedisEventClient = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type RedisLogger = (entry: Record<string, unknown>) => void;

const maxBackoffMs = 5_000;
const logIntervalMs = 5_000;

export function redisReconnectDelay(attempt: number, random: () => number = Math.random) {
  const exponential = Math.min(maxBackoffMs, 100 * 2 ** Math.min(Math.max(0, attempt), 6));
  const jitter = Math.floor(random() * Math.min(500, Math.max(25, exponential / 2)));
  return Math.min(maxBackoffMs, exponential + jitter);
}

export class RedisConnectionHealth {
  private state: RedisConnectionState = 'connecting';
  private readonly listeners = new Set<(state: RedisConnectionState) => void>();
  private lastErrorLogAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly name: string, private readonly log: RedisLogger = entry => console.info(JSON.stringify(entry)), private readonly now: () => number = Date.now) {}

  getState() { return this.state; }
  isReady() { return this.state === 'ready'; }

  subscribe(listener: (state: RedisConnectionState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bind(client: RedisEventClient) {
    client.on('ready', () => this.setState('ready'));
    client.on('reconnecting', () => this.setState('reconnecting'));
    client.on('end', () => this.setState('unavailable'));
    client.on('error', error => {
      this.setState('unavailable');
      this.logError(error);
    });
    return this;
  }

  close() { this.setState('closed'); }

  private setState(next: RedisConnectionState) {
    if (this.state === next) return;
    this.state = next;
    this.log({ level: next === 'ready' ? 'info' : 'warn', event: 'redis_connection_state', client: this.name, state: next });
    for (const listener of this.listeners) listener(next);
  }

  private logError(error: unknown) {
    const now = this.now();
    if (now - this.lastErrorLogAt < logIntervalMs) return;
    this.lastErrorLogAt = now;
    const message = error instanceof Error ? error.message : String(error);
    this.log({ level: 'warn', event: 'redis_connection_error', client: this.name, message });
  }
}

export function createResilientRedisClient(url: string, name: string, log?: RedisLogger) {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: attempt => redisReconnectDelay(attempt),
    },
  });
  const health = new RedisConnectionHealth(name, log).bind(client);
  return { client, health };
}

export function connectInBackground(client: { connect: () => Promise<unknown> }, health: RedisConnectionHealth, name: string, log: RedisLogger = entry => console.info(JSON.stringify(entry))) {
  void client.connect().catch(error => {
    if (health.getState() !== 'closed') {
      const message = error instanceof Error ? error.message : String(error);
      log({ level: 'warn', event: 'redis_initial_connection_failed', client: name, message });
    }
  });
}
