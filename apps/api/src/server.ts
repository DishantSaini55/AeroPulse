import { createApp } from './app.js';
import { createDb } from './db.js';
import { TelemetrySimulator } from './simulator/service.js';
import { WeatherService } from './weather/service.js';
import { createServer } from 'node:http';
import { attachRealtime } from './realtime.js';
import { AuthService, requireJwtSecret } from './auth.js';

const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const db = createDb();
await db.$connect();
const auth = new AuthService(db, requireJwtSecret());
const weather = new WeatherService(db);
let io: ReturnType<typeof attachRealtime>;
const server = createServer(createApp(db, weather, auth, userId => io.to(`user:${userId}`).disconnectSockets(true)));
io = attachRealtime(server, auth);
const simulator = new TelemetrySimulator(db, 5000, event => io.emit('telemetry:batch', event));
simulator.start();
weather.start();
server.listen(port, () => {
  console.log(`AeroPulse API listening on http://localhost:${port}`);
});

async function shutdown() {
  await simulator.stop();
  await weather.stop();
  await new Promise<void>(resolve => io.close(() => resolve()));
  await db.$disconnect();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
