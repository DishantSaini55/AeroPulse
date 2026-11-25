import { createApp } from './app.js';
import { createDb } from './db.js';
import { TelemetrySimulator } from './simulator/service.js';
import { WeatherService } from './weather/service.js';
import { createServer } from 'node:http';
import { attachRealtime, attachRedisRealtime } from './realtime.js';
import { AuthService, requireJwtSecret } from './auth.js';
import { heartbeatPolicyFromEnv } from './heartbeat/monitor.js';
import { RedundancyManager } from './failover/manager.js';
import { DiagnosisService } from './diagnostics/service.js';
import { AlarmService } from './alarms/service.js';
import { IncidentService } from './incidents/service.js';
import { startLeadership } from './cluster/leader.js';

const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const db = createDb();
await db.$connect();
const auth = new AuthService(db, requireJwtSecret());
const weather = new WeatherService(db);
const heartbeatPolicy = heartbeatPolicyFromEnv();
let io: ReturnType<typeof attachRealtime>;
let cluster: Awaited<ReturnType<typeof attachRedisRealtime>>;
const diagnosis = new DiagnosisService(db, heartbeatPolicy.timeoutMs, heartbeatPolicy.expectedIntervalMs);
const alarms = new AlarmService(db, event => io.emit('alarm:raised', event));
const incidents = new IncidentService(db, () => io.emit('incident:changed', { simulated: true }));
const simulator = new TelemetrySimulator(db, 5000, event => {
  io.emit('telemetry:batch', event);
  void (async () => {
    try { await diagnosis.scan(); }
    catch (error) { console.error('Diagnosis scan failed', error); }
    await alarms.sync();
    await incidents.sync();
  })().catch(error => console.error('Alarm scan failed', error));
}, control => { void cluster?.publishControl(control).catch(error => console.error('Simulator control broadcast failed', error)); });
const redundancyManager = new RedundancyManager(db, heartbeatPolicy, change => {
  io.emit('status:changed', change);
  void alarms.sync().then(() => incidents.sync()).catch(error => console.error('Outage incident scan failed', error));
});
const server = createServer(createApp(db, weather, auth, userId => io.to(`user:${userId}`).disconnectSockets(true), heartbeatPolicy, redundancyManager, simulator, incidents));
io = attachRealtime(server, auth);
cluster = await attachRedisRealtime(io, process.env.REDIS_URL);
await cluster?.onControl(control => simulator.applyControl(control));

let jobsRunning = false;
async function startLeaderJobs() {
  if (jobsRunning) return;
  jobsRunning = true;
  console.log(`AeroPulse instance ${process.env.INSTANCE_ID ?? 'local'} became background-job leader`);
  void incidents.sync().catch(error => console.error('Initial incident scan failed', error));
  simulator.start();
  redundancyManager.start();
  weather.start();
}
async function stopLeaderJobs() {
  if (!jobsRunning) return;
  jobsRunning = false;
  await Promise.all([simulator.stop(), redundancyManager.stop(), weather.stop()]);
  console.log(`AeroPulse instance ${process.env.INSTANCE_ID ?? 'local'} stopped background jobs`);
}
const leadership = await startLeadership(process.env.REDIS_URL, { onLeader: startLeaderJobs, onFollower: stopLeaderJobs });
server.listen(port, () => {
  console.log(`AeroPulse API ${process.env.INSTANCE_ID ?? 'local'} listening on http://localhost:${port}; leader=${leadership.isLeader()}`);
});

async function shutdown() {
  await leadership.stop();
  await new Promise<void>(resolve => io.close(() => resolve()));
  await cluster?.close();
  await db.$disconnect();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
