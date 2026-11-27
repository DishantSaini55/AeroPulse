import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { SignJWT } from 'jose';
import { io as connectSocket } from 'socket.io-client';

const run = promisify(execFile);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://aeropulse_test:aeropulse_test@127.0.0.1:55432/aeropulse_test?schema=public';
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.pathname, '/aeropulse_test');
const { createDb } = await import('../dist/db.js');
const { NotificationService } = await import('../dist/notifications/service.js');
const db = createDb();
const compose = resolve('../../docker-compose.maintenance-runtime.yml');
const docker = (...args) => run('docker', ['compose', '-f', compose, ...args], { timeout: 60_000 });
const processes = []; const sockets = []; const logs = []; const events = [];
const secret = crypto.randomUUID() + crypto.randomUUID(); let user;
const freePort = async () => { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const waitFor = async (label, check, timeout = 90_000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) { console.log(`PASS ${label}`); return; } await new Promise(resolve => setTimeout(resolve, 300)); } throw new Error(`Timed out: ${label}`); };
try {
  await docker('up', '-d', '--wait');
  user = await db.user.create({ data: { email: `redis-notification-${crypto.randomUUID()}@test.local`, name: 'Redis notification verifier', role: 'SUPERVISOR', passwordHash: 'local-only' } });
  const ports = [await freePort(), await freePort()]; const lock = `notification-verify:${crypto.randomUUID()}`;
  for (const [index, port] of ports.entries()) {
    const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, PORT: String(port), JWT_SECRET: secret, REDIS_URL: 'redis://127.0.0.1:56379', LEADER_LOCK_KEY: lock, LEADER_LOCK_TTL_MS: '3000', LEADER_RENEW_MS: '500', INSTANCE_ID: `notification-${index}` }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(child); child.stdout.on('data', data => logs.push(`API-${index} ${data}`)); child.stderr.on('data', data => logs.push(`API-${index} ${data}`));
  }
  const health = async () => Promise.all(ports.map(async port => { try { return (await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json()).runtime; } catch { return null; } }));
  await waitFor('two backends are Redis-ready with exactly one notification dispatcher leader', async () => { const state = await health(); return state.every(x => x?.redis === 'ready') && state.filter(x => x.leader && x.backgroundJobs).length === 1; });
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setIssuer('aeropulse').setAudience('aeropulse-web').setExpirationTime('10m').sign(new TextEncoder().encode(secret));
  const received = ports.map(() => []);
  for (const [index, port] of ports.entries()) { const socket = connectSocket(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'] }); socket.on('notifications:changed', event => received[index].push(event)); sockets.push(socket); }
  await waitFor('authenticated notification clients are connected to both backends', () => sockets.every(socket => socket.connected));
  const service = new NotificationService(db);
  const first = `redis-notification:${crypto.randomUUID()}`; events.push(first); await service.record({ sourceKey: first, kind: 'INCIDENT_CHANGED', priority: 'MAJOR', title: 'Before Redis interruption', body: 'Cross-backend fanout' }); await db.notificationDelivery.updateMany({ where: { recipient: { event: { sourceKey: first } } }, data: { createdAt: new Date('1800-01-01T00:00:00Z'), nextAttemptAt: new Date(0) } });
  await waitFor('leader dispatches durable notification to clients on both backends', async () => (await db.notificationDelivery.count({ where: { recipient: { event: { sourceKey: first } }, status: 'DELIVERED' } })) > 0 && received.every(list => list.length > 0));
  await docker('stop', 'redis');
  await waitFor('Redis interruption makes both backends followers and stops notification dispatch', async () => (await health()).every(state => state?.redis === 'degraded' && !state.leader && !state.backgroundJobs));
  const second = `redis-notification:${crypto.randomUUID()}`; events.push(second); await service.record({ sourceKey: second, kind: 'MAINTENANCE_ASSIGNED', priority: 'WARNING', title: 'During Redis interruption', body: 'Must remain pending until recovery' }); await db.notificationDelivery.updateMany({ where: { recipient: { event: { sourceKey: second } } }, data: { createdAt: new Date('1800-01-01T00:00:00Z'), nextAttemptAt: new Date(0) } });
  assert.equal(await db.notificationDelivery.count({ where: { recipient: { event: { sourceKey: second } }, status: 'DELIVERED' } }), 0);
  await docker('start', 'redis');
  await waitFor('Redis recovery elects exactly one dispatcher leader', async () => { const state = await health(); return state.every(x => x?.redis === 'ready') && state.filter(x => x.leader && x.backgroundJobs).length === 1; });
  await waitFor('pending notification recovers once and reaches both backend clients', async () => (await db.notificationDelivery.count({ where: { recipient: { event: { sourceKey: second } }, status: 'DELIVERED' } })) > 0 && received.every(list => list.length >= 2));
  console.log('REDIS NOTIFICATION INTERRUPTION/RECOVERY VERIFIED');
} catch (error) { console.error(error); console.error(logs.slice(-80).join('')); process.exitCode = 1; }
finally {
  sockets.forEach(socket => socket.disconnect()); processes.forEach(child => child.kill('SIGTERM')); await Promise.all(processes.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
  if (events.length) await db.notificationEvent.deleteMany({ where: { sourceKey: { in: events } } }); if (user) { await db.auditEvent.deleteMany({ where: { actorId: user.id } }); await db.user.delete({ where: { id: user.id } }); } await db.$disconnect(); await docker('stop', 'redis').catch(() => {});
}
