import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { SignJWT } from 'jose';
import { io } from 'socket.io-client';

const run = promisify(execFile);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://aeropulse_test:aeropulse_test@127.0.0.1:55432/aeropulse_test?schema=public';
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.pathname, '/aeropulse_test', 'Runtime verification must use the isolated database');
const { createDb } = await import('../dist/db.js');
const { MaintenanceService } = await import('../dist/maintenance/service.js');
const db = createDb();
const compose = resolve('../../docker-compose.maintenance-runtime.yml');
const docker = (...args) => run('docker', ['compose', '-f', compose, ...args], { timeout: 60000 });
const processes = [];
const logs = [];
const secret = crypto.randomUUID() + crypto.randomUUID();
const freePort = async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
const waitFor = async (label, check, timeout = 90000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) { console.log('PASS ' + label); return; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Timed out: ' + label);
};
let systemId;
let socket;
let otherSocket;
try {
  await docker('up', '-d', '--wait');
  const marker = crypto.randomUUID().slice(0, 8);
  const system = await db.logicalSystem.create({ data: { code: 'RT' + marker, name: 'Runtime verification ' + marker } });
  systemId = system.id;
  const actor = await db.user.create({ data: { email: 'runtime-' + marker + '@test.local', name: 'Runtime supervisor', passwordHash: 'test', role: 'SUPERVISOR' } });
  const primary = await db.device.create({ data: { systemId, code: 'RT' + marker + '-P', name: 'Runtime primary', role: 'PRIMARY', activationState: 'ACTIVE' } });
  await db.device.create({ data: { systemId, code: 'RT' + marker + '-S', name: 'Runtime standby', role: 'SECONDARY' } });
  const plan = await new MaintenanceService(db).createPlan({ name: 'Runtime plan', deviceId: primary.id, category: 'Inspection', description: 'Distributed runtime evidence', checklist: ['Inspect'], frequency: 'MONTHLY', advanceNoticeDays: 1, estimatedDurationMinutes: 30, priority: 'LOW' }, actor.id);
  await db.maintenancePlan.update({ where: { id: plan.id }, data: { nextScheduledAt: new Date(Date.now() - 1000) } });
  const ports = [await freePort(), await freePort()];
  for (let i = 0; i < 2; i++) {
    const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, PORT: String(ports[i]), JWT_SECRET: secret,
      REDIS_URL: 'redis://127.0.0.1:56379', LEADER_LOCK_KEY: 'maintenance-verify:' + marker, INSTANCE_ID: 'verify-' + i }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(child);
    console.log('Started API-' + i + ' pid=' + child.pid + ' port=' + ports[i]);
    child.stdout.on('data', data => logs.push('API-' + i + ' ' + data));
    child.stderr.on('data', data => logs.push('API-' + i + ' ' + data));
  }
  const health = async () => Promise.all(ports.map(async port => {
    try { return (await (await fetch('http://127.0.0.1:' + port + '/api/v1/health')).json()).runtime; } catch { return null; }
  }));
  await waitFor('two backends ready, exactly one job leader', async () => {
    const states = await health();
    return states.every(state => state?.redis === 'ready') && states.filter(state => state.leader && state.backgroundJobs).length === 1;
  });
  console.log('Initial runtime states: ' + JSON.stringify(await health()));
  await waitFor('one persisted recurring occurrence across both backends', async () => await db.maintenanceWorkOrder.count({ where: { planId: plan.id } }) === 1);
  await docker('stop', 'redis');
  await waitFor('Redis interruption suspends jobs on both backends', async () => (await health()).every(state => state && !state.leader && !state.backgroundJobs && state.redis === 'degraded'));
  console.log('Interrupted runtime states: ' + JSON.stringify(await health()));
  await db.maintenancePlan.update({ where: { id: plan.id }, data: { nextScheduledAt: new Date(Date.now() - 1000) } });
  await docker('start', 'redis');
  await waitFor('Redis restoration recovers exactly one leader', async () => {
    const states = await health();
    return states.every(state => state?.redis === 'ready') && states.filter(state => state.leader && state.backgroundJobs).length === 1;
  });
  console.log('Recovered runtime states: ' + JSON.stringify(await health()));
  await waitFor('scheduler recovers due occurrence after Redis restoration', async () => await db.maintenanceWorkOrder.count({ where: { planId: plan.id } }) === 2);
  const rows = await db.maintenanceWorkOrder.findMany({ where: { planId: plan.id } });
  assert.equal(new Set(rows.map(row => row.occurrenceKey)).size, 2);
  await waitFor('live heartbeat evidence for planned maintenance', async () => await db.heartbeat.count({ where: { device: { systemId }, recordedAt: { gte: new Date(Date.now() - 10000) } } }) >= 2);
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(actor.id).setIssuedAt().setIssuer('aeropulse').setAudience('aeropulse-web').setExpirationTime('5m').sign(new TextEncoder().encode(secret));
  const notices = [];
  const otherNotices = [];
  socket = io('http://127.0.0.1:' + ports[1], { auth: { token }, transports: ['websocket'] });
  otherSocket = io('http://127.0.0.1:' + ports[0], { auth: { token }, transports: ['websocket'] });
  socket.on('maintenance:changed', event => { if (event.systemCodes?.includes(system.code)) notices.push(event); });
  otherSocket.on('maintenance:changed', event => { if (event.systemCodes?.includes(system.code)) otherNotices.push(event); });
  await waitFor('authenticated Socket.IO clients connected to both backends', async () => socket.connected && otherSocket.connected);
  const starts = await Promise.all(ports.map(port => fetch('http://127.0.0.1:' + port + '/api/v1/maintenance/work-orders/' + rows[0].id + '/start', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}',
  })));
  assert.deepEqual(starts.map(response => response.status).sort(), [200, 409]);
  assert.equal(await db.device.count({ where: { systemId, activationState: 'ACTIVE' } }), 1);
  console.log('PASS concurrent maintenance REST start on API-A/API-B: 200/409, one active device');
  await waitFor('authoritative maintenance events reach users on both backends after commit', async () => notices.length > 0 && otherNotices.length > 0);
  const request = async (suffix, body, method = 'POST') => fetch('http://127.0.0.1:' + ports[1] + '/api/v1/maintenance/work-orders/' + rows[0].id + suffix, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const checklist = await db.workOrderChecklistItem.findMany({ where: { workOrderId: rows[0].id } });
  for (const item of checklist) assert.equal((await request('/checklist/' + item.id, { result: 'PASSED' }, 'PATCH')).status, 200);
  assert.equal((await request('/verify', { passed: false, remarks: 'Failed verification evidence' })).status, 200);
  assert.equal((await db.device.findUniqueOrThrow({ where: { id: primary.id } })).maintenanceEligible, false);
  assert.equal((await request('/approve', {})).status, 409);
  assert.equal((await request('/verify', { passed: true, remarks: 'Successful post-maintenance evidence' })).status, 200);
  assert.equal((await request('/reject', { reason: 'Review evidence again' })).status, 200);
  assert.equal((await db.device.findUniqueOrThrow({ where: { id: primary.id } })).maintenanceEligible, false);
  assert.equal((await request('/verify', { passed: true, remarks: 'Reverified evidence after review' })).status, 200);
  assert.equal((await request('/approve', {})).status, 200);
  const restored = await db.device.findUniqueOrThrow({ where: { id: primary.id } });
  assert.equal(restored.maintenanceEligible, true);
  assert.equal(restored.activationState, 'STANDBY');
  console.log('PASS failed verification/rejection remain ineligible; authorized approval restores standby eligibility');
  assert.equal(await db.failoverEvent.count({ where: { systemId, action: 'PLANNED_MAINTENANCE' } }), 1);
  assert.equal(await db.failoverEvent.count({ where: { systemId, action: 'AUTOMATIC_FAILOVER' } }), 0);
  assert.equal(await db.alarm.count({ where: { device: { systemId }, level: 'CRITICAL' } }), 0);
  console.log('PASS routine maintenance creates one planned event, no automatic failure event or critical alarm');
  const completed = await db.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: rows[0].id } });
  const { recordedAnalyticsInput } = await import('../dist/analytics/source.js');
  const { calculateReliability } = await import('../dist/analytics/metrics.js');
  const analyticsInput = await recordedAnalyticsInput(db, completed.actualStartAt, completed.completedAt);
  assert.equal(analyticsInput.devices.find(device => device.id === primary.id).healthyObservedMs, 0);
  assert.ok(calculateReliability(analyticsInput, completed.actualStartAt, completed.completedAt, 'RECORDED').summary.plannedEquipmentUnavailabilityMs > 0);
  console.log('PASS recorded PostgreSQL analytics excludes planned heartbeat samples and reports planned unavailability');
  console.log('RUNTIME VERIFICATION PASSED');
} catch (error) {
  console.error(error);
  console.error(logs.slice(-60).join(''));
  process.exitCode = 1;
} finally {
  socket?.disconnect();
  otherSocket?.disconnect();
  for (const child of processes) child.kill('SIGTERM');
  await Promise.all(processes.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
  if (systemId) {
    const where = { systemId };
    await db.workOrderChecklistItem.deleteMany({ where: { workOrder: where } });
    await db.workOrderPartUsage.deleteMany({ where: { workOrder: where } });
    await db.workOrderStatusHistory.deleteMany({ where: { workOrder: where } });
    await db.maintenanceWorkOrder.deleteMany({ where });
    await db.maintenancePlan.deleteMany({ where });
    await db.failoverEvent.deleteMany({ where });
    await db.alarm.deleteMany({ where: { device: where } });
    await db.faultDiagnosis.deleteMany({ where: { device: where } });
    await db.telemetryReading.deleteMany({ where: { device: where } });
    await db.heartbeat.deleteMany({ where: { device: where } });
    await db.device.deleteMany({ where });
    await db.logicalSystem.delete({ where: { id: systemId } });
  }
  await db.$disconnect();
  await docker('stop', 'redis');
}
