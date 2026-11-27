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
import { RetentionService, telemetryRetentionDays } from './retention.js';
import { MaintenanceService } from './maintenance/service.js';
import { MaintenanceScheduler } from './maintenance/scheduler.js';
import { NotificationService } from './notifications/service.js';

const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const db = createDb();
await db.$connect();
const auth = new AuthService(db, requireJwtSecret());
const weather = new WeatherService(db);
const heartbeatPolicy = heartbeatPolicyFromEnv();
const retention = new RetentionService(db, telemetryRetentionDays());
let io: ReturnType<typeof attachRealtime>;
let cluster: Awaited<ReturnType<typeof attachRedisRealtime>>;
let leadership: Awaited<ReturnType<typeof startLeadership>>;
let jobsRunning = false;
let notificationDispatchTimer: NodeJS.Timeout | undefined;
const diagnosis = new DiagnosisService(db, heartbeatPolicy.timeoutMs, heartbeatPolicy.expectedIntervalMs);
const notifications = new NotificationService(db, userIds => {
  for (const userId of userIds) io.to(`user:${userId}`).emit('notifications:changed', { simulated: true });
});
const alarms = new AlarmService(db, event => {
  io.emit('alarm:raised', event);
  void notifications.record({ sourceKey: `alarm:${event.id}`, kind: 'ALARM_RAISED', priority: event.level, title: `${event.level} alarm — ${event.deviceCode}`, body: event.message }).catch(error => console.error('Notification outbox write failed', error));
});
const incidents = new IncidentService(db, () => io.emit('incident:changed', { simulated: true }));
const simulator = new TelemetrySimulator(db, 5000, event => {
  io.emit('telemetry:batch', event);
  void (async () => {
    try { await diagnosis.scan(); }
    catch (error) { console.error('Diagnosis scan failed', error); }
    await alarms.sync();
    await incidents.sync();
  })().catch(error => console.error('Alarm scan failed', error));
}, async control => {
  if (process.env.REDIS_URL && !cluster?.isReady()) throw new Error('Redis distributed control is unavailable');
  await cluster?.publishControl(control);
});
const redundancyManager = new RedundancyManager(db, heartbeatPolicy, change => {
  io.emit('status:changed', change);
  io.emit('maintenance:changed', change);
  void alarms.sync().then(() => incidents.sync()).catch(error => console.error('Outage incident scan failed', error));
});
const simulationControlAvailable = () => !process.env.REDIS_URL || cluster?.isReady() === true;
const maintenanceScheduler = new MaintenanceScheduler(new MaintenanceService(db), 30_000,
  () => jobsRunning && simulationControlAvailable(), () => io.emit('maintenance:changed', { simulated: true }));
const runtimeStatus = () => ({
  redis: process.env.REDIS_URL ? (cluster?.isReady() ? 'ready' as const : 'degraded' as const) : undefined,
  leader: leadership?.isLeader() ?? false,
  backgroundJobs: jobsRunning,
});
const server = createServer(createApp(db, weather, auth, userId => io.to(`user:${userId}`).disconnectSockets(true), heartbeatPolicy, redundancyManager, simulator, incidents, simulationControlAvailable, runtimeStatus, () => io.emit('maintenance:changed', { simulated: true })));
io = attachRealtime(server, auth);
cluster = attachRedisRealtime(io, process.env.REDIS_URL);
await cluster?.onControl(control => simulator.applyControl(control));

async function startLeaderJobs() {
  if (jobsRunning) return;
  jobsRunning = true;
  console.log(`AeroPulse instance ${process.env.INSTANCE_ID ?? 'local'} became background-job leader`);
  void incidents.sync().catch(error => console.error('Initial incident scan failed', error));
  simulator.start();
  redundancyManager.start();
  weather.start();
  retention.start();
  maintenanceScheduler.start();
  const dispatchNotifications = () => void notifications.dispatchDue(100, userId => { io.to(`user:${userId}`).emit('notifications:changed', { simulated: true }); }).catch(error => console.error('Notification outbox dispatch failed', error));
  dispatchNotifications();
  notificationDispatchTimer = setInterval(dispatchNotifications, 5_000);
}
async function stopLeaderJobs() {
  if (!jobsRunning) return;
  jobsRunning = false;
  if (notificationDispatchTimer) { clearInterval(notificationDispatchTimer); notificationDispatchTimer = undefined; }
  await Promise.all([simulator.stop(), redundancyManager.stop(), weather.stop(), retention.stop(), maintenanceScheduler.stop()]);
  console.log(`AeroPulse instance ${process.env.INSTANCE_ID ?? 'local'} stopped background jobs`);
}
leadership = await startLeadership(process.env.REDIS_URL, { onLeader: startLeaderJobs, onFollower: stopLeaderJobs });
server.listen(port, () => {
  console.log(`AeroPulse API ${process.env.INSTANCE_ID ?? 'local'} listening on http://localhost:${port}; leader=${leadership.isLeader()}`);
});

server.on('error', error => console.error('HTTP server error', error));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`AeroPulse API ${process.env.INSTANCE_ID ?? 'local'} is shutting down`);
  await leadership.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await new Promise<void>(resolve => io.close(() => resolve()));
  await cluster?.close();
  await db.$disconnect();
}
process.once('SIGINT', () => { void shutdown().catch(error => { console.error('Shutdown failed', error); process.exitCode = 1; }); });
process.once('SIGTERM', () => { void shutdown().catch(error => { console.error('Shutdown failed', error); process.exitCode = 1; }); });
