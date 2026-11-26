import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { AuthProvider } from './auth.js';
import type { StatusChange } from './heartbeat/monitor.js';
import type { AlarmNotice } from './alarms/service.js';
import { connectInBackground, createResilientRedisClient } from './cluster/redis.js';

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
  isReady: () => boolean;
  health: () => Record<string, string>;
};

const controlTopic = 'aeropulse:simulator-control';

function validControl(value: unknown): value is SimulatorControl {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SimulatorControl>;
  return typeof candidate.deviceCode === 'string' && ((candidate.kind === 'SCENARIO' && typeof candidate.scenario === 'string') || (candidate.kind === 'HEARTBEAT' && typeof candidate.paused === 'boolean'));
}

export function attachRedisRealtime(io: ReturnType<typeof attachRealtime>, redisUrl?: string): RealtimeCluster | undefined {
  if (!redisUrl) return undefined;
  const publisherConnection = createResilientRedisClient(redisUrl, 'socketio-publisher');
  const adapterConnection = createResilientRedisClient(redisUrl, 'socketio-adapter-subscriber');
  const controlConnection = createResilientRedisClient(redisUrl, 'simulator-control-subscriber');
  const publisher = publisherConnection.client;
  const adapterSubscriber = adapterConnection.client;
  const controlSubscriber = controlConnection.client;
  const connections = [publisherConnection, adapterConnection, controlConnection];
  let adapterAttached = false;
  let subscribed = false;
  let closed = false;
  let controlListener: ((control: SimulatorControl) => void) | undefined;

  const isReady = () => !closed && connections.every(connection => connection.health.isReady());
  const subscribeControl = async () => {
    if (!controlListener || subscribed || !controlConnection.health.isReady()) return;
    try {
      await controlSubscriber.subscribe(controlTopic, message => {
        try {
          const control = JSON.parse(message) as unknown;
          if (validControl(control)) controlListener?.(control);
        } catch { console.error('Ignored invalid simulator control message'); }
      });
      subscribed = true;
    } catch (error) {
      console.error('Simulator control subscription failed', error);
    }
  };
  const activate = () => {
    if (!isReady()) return;
    if (!adapterAttached) {
      io.adapter(createAdapter(publisher, adapterSubscriber));
      adapterAttached = true;
    }
    void subscribeControl();
  };
  for (const [connection, name] of [[publisherConnection, 'socketio-publisher'], [adapterConnection, 'socketio-adapter-subscriber'], [controlConnection, 'simulator-control-subscriber']] as const) {
    connection.health.subscribe(() => activate());
    connectInBackground(connection.client, connection.health, name);
  }

  return {
    publishControl: async control => {
      if (!isReady()) throw new Error('Distributed simulator control is unavailable while Redis is reconnecting');
      try { await publisher.publish(controlTopic, JSON.stringify(control)); }
      catch (error) { console.error('Simulator control publish failed', error); throw error; }
    },
    onControl: async listener => {
      if (controlListener) throw new Error('Simulator control listener is already registered');
      controlListener = listener;
      await subscribeControl();
    },
    isReady,
    health: () => ({ publisher: publisherConnection.health.getState(), adapterSubscriber: adapterConnection.health.getState(), controlSubscriber: controlConnection.health.getState() }),
    close: async () => {
      closed = true;
      for (const connection of connections) connection.health.close();
      await Promise.all(connections.map(async connection => {
        try { await connection.client.quit(); }
        catch (error) { console.error('Redis client shutdown failed', error); }
      }));
    },
  };
}
