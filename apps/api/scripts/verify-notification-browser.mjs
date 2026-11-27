import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import express from 'express';
import { SignJWT } from 'jose';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://aeropulse_test:aeropulse_test@127.0.0.1:55432/aeropulse_test?schema=public';
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.pathname, '/aeropulse_test');
const { chromium } = (await import('../../web/node_modules/@playwright/test/index.js')).default;
const { createDb } = await import('../dist/db.js');
const { createApp } = await import('../dist/app.js');
const { AuthService } = await import('../dist/auth.js');
const { attachRealtime } = await import('../dist/realtime.js');
const { NotificationService } = await import('../dist/notifications/service.js');
const db = createDb(); const secret = crypto.randomUUID() + crypto.randomUUID();
const marker = `Live inbox ${crypto.randomUUID().slice(0, 8)}`;
let user, server, io, browser, page, events = [];
const waitFor = async (label, check, timeout = 30_000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${label}`); };
try {
  console.log('Starting live browser notification verification');
  user = await db.user.create({ data: { email: `live-inbox-${crypto.randomUUID()}@test.local`, name: marker, role: 'SUPERVISOR', passwordHash: 'local-only' } });
  const http = express(); let realtime;
  const notifications = new NotificationService(db, userIds => userIds.forEach(userId => realtime.to(`user:${userId}`).emit('notifications:changed', { simulated: true })));
  const auth = new AuthService(db, secret); const api = createApp(db, undefined, auth);
  http.use(express.static(resolve('../web/dist'))); http.use((request, response, next) => request.path.startsWith('/api/') ? api(request, response, next) : next()); http.use((_request, response) => response.sendFile(resolve('../web/dist/index.html')));
  server = createServer(http); realtime = attachRealtime(server, auth); io = realtime;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setIssuer('aeropulse').setAudience('aeropulse-web').setExpirationTime('10m').sign(new TextEncoder().encode(secret));
  const firstKey = `live-browser:${crypto.randomUUID()}`; events.push(firstKey);
  await notifications.record({ sourceKey: firstKey, kind: 'INCIDENT_CHANGED', priority: 'MAJOR', title: marker, body: 'Persisted through the live browser API' });
  browser = await chromium.launch({ headless: true }); page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.addInitScript(value => sessionStorage.setItem('aeropulse-token', value), token);
  await page.goto(`${origin}/notifications`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Notification inbox' }).waitFor(); await waitFor('authenticated Socket.IO connection', () => io.sockets.sockets.size === 1); await page.getByText(marker, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Mark read', exact: true }).click(); await waitFor('read persisted', async () => (await db.notificationRecipient.findFirstOrThrow({ where: { event: { sourceKey: firstKey }, userId: user.id } })).readAt !== null);
  await page.getByLabel('Enabled').uncheck(); await waitFor('preference persisted', async () => (await db.notificationPreference.findUnique({ where: { userId: user.id } }))?.inAppEnabled === false);
  const secondTitle = `${marker} socket`; const secondKey = `live-browser:${crypto.randomUUID()}`; events.push(secondKey);
  await notifications.record({ sourceKey: secondKey, kind: 'MAINTENANCE_ASSIGNED', priority: 'WARNING', title: secondTitle, body: 'Socket invalidation followed by REST reconciliation' });
  await page.getByText(secondTitle, { exact: true }).waitFor({ timeout: 30_000 }); assert.deepEqual(errors, []);
  console.log('PASS live browser notification workflow: authenticated REST, persisted read/preference, Socket.IO invalidation and REST reconciliation');
} catch (error) { console.error(error); if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 2000)); process.exitCode = 1; }
finally {
  await browser?.close(); if (io) await new Promise(resolve => io.close(resolve)); if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (events.length) await db.notificationEvent.deleteMany({ where: { sourceKey: { in: events } } }); if (user) { await db.auditEvent.deleteMany({ where: { actorId: user.id } }); await db.user.delete({ where: { id: user.id } }); } await db.$disconnect();
}
