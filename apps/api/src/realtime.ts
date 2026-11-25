import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';

export type TelemetryBatchEvent = {
  recordedAt: string;
  deviceCodes: string[];
  simulated: true;
};

interface ServerToClientEvents {
  'telemetry:batch': (event: TelemetryBatchEvent) => void;
}

export function attachRealtime(server: HttpServer) {
  return new Server<Record<string, never>, ServerToClientEvents>(server, {
    path: '/socket.io',
  });
}
