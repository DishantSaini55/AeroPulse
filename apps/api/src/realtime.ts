import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, type RedisClientType } from 'redis';
import type { AuthProvider } from './auth.js';
import type { StatusChange } from './heartbeat/monitor.js';
import type { AlarmNotice } from './alarms/service.js';

export type TelemetryBatchEvent = {
  recordedAt: string;
  deviceCodes: string[];
  simulated: true;
};

interface ServerToClientEvents {
  'telemetry:batch': (event: TelemetryBatchEvent) => void;
  'status:changed': (event: StatusChange) => void;
  'alarm:raised': (event: AlarmNotice) => void;
  'incident:changed': (event: { simulated: true }) => void;
}

export function attachRealtime(server: HttpServer, auth?: AuthProvider) {
  const io = new Server<Record<string, never>, ServerToClientEvents>(server, {
    path: '/socket.io',
  });
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = auth && typeof token === 'string' ? await auth.verifyToken(token) : null;
    if (!user) {
      next(new Error('Unauthorized'));
      return;
    }
    socket.data.userId = user.id;
    next();
  });
  io.on('connection', socket => {
    socket.join(`user:${socket.data.userId}`);
  });
  return io;
}

export type SimulatorControl = { kind: 'SCENARIO'; deviceCode: string; scenario: string } | { kind: 'HEARTBEAT'; deviceCode: string; paused: boolean };

export type RealtimeCluster = {
  publishControl: (control: SimulatorControl) => Promise<void>;
  onControl: (listener: (control: SimulatorControl) => void) => Promise<void>;
  close: () => Promise<void>;
};

const controlTopic = 'aeropulse:simulator-control';

function validControl(value: unknown): value is SimulatorControl {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SimulatorControl>;
  return typeof candidate.deviceCode === 'string' && ((candidate.kind === 'SCENARIO' && typeof candidate.scenario === 'string') || (candidate.kind === 'HEARTBEAT' && typeof candidate.paused === 'boolean'));
}

export async function attachRedisRealtime(io: ReturnType<typeof attachRealtime>, redisUrl?: string): Promise<RealtimeCluster | undefined> {
  if (!redisUrl) return undefined;
  const publisher = createClient({ url: redisUrl });
  const adapterSubscriber = publisher.duplicate();
  const controlSubscriber = publisher.duplicate();
  await Promise.all([publisher.connect(), adapterSubscriber.connect(), controlSubscriber.connect()]);
  io.adapter(createAdapter(publisher, adapterSubscriber));
  return {
    publishControl: async control => { await publisher.publish(controlTopic, JSON.stringify(control)); },
    onControl: async listener => {
      await controlSubscriber.subscribe(controlTopic, message => {
        try { const control = JSON.parse(message) as unknown; if (validControl(control)) listener(control); }
        catch { console.error('Ignored invalid simulator control message'); }
      });
    },
    close: async () => { await Promise.all([publisher.quit(), adapterSubscriber.quit(), controlSubscriber.quit()]); },
  };
}
