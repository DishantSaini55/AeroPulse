import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
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
