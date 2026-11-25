import { io } from 'socket.io-client';

const address = process.env.REALTIME_URL ?? 'http://127.0.0.1:5173';
const socket = io(address, { path: '/socket.io', transports: ['websocket'], autoConnect: false });

try {
  const event = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No telemetry event received within 15 seconds')), 15_000);
    socket.once('connect_error', error => { clearTimeout(timeout); reject(error); });
    socket.once('telemetry:batch', batch => { clearTimeout(timeout); resolve(batch); });
    socket.connect();
  });
  if (event.simulated !== true || event.deviceCodes?.length !== 20) throw new Error('Unexpected telemetry event');
  console.log(`Live stream verified: ${event.deviceCodes.length} simulated devices at ${event.recordedAt}`);
} finally {
  socket.disconnect();
}
