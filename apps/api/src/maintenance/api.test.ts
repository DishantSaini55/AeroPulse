import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { createDb } from '../db.js';
import type { AuthProvider } from '../auth.js';
import { MaintenanceService } from './service.js';

const db = process.env.DATABASE_URL ? createDb() : undefined;
const identities = new Map<string, { id: string; email: string; name: string; role: 'ADMINISTRATOR' | 'SUPERVISOR' | 'MAINTENANCE_ENGINEER'; active: boolean }>();
const auth: AuthProvider = { login: async () => null, verifyToken: async token => identities.get(token) ?? null };
let server: Server | undefined;
let baseUrl = '';
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await db?.$disconnect();
});

test('mounted maintenance APIs persist plans, assignment, parts, costs and cancellation with authorization', { skip: !db }, async () => {
  await db!.$connect();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const admin = await db!.user.create({ data: { email: `maintenance-admin-${suffix}@example.test`, name: 'Maintenance Admin', passwordHash: 'test-hash', role: 'ADMINISTRATOR' } });
  const engineer = await db!.user.create({ data: { email: `maintenance-engineer-${suffix}@example.test`, name: 'Maintenance Engineer', passwordHash: 'test-hash', role: 'MAINTENANCE_ENGINEER' } });
  identities.set('admin', { id: admin.id, email: admin.email, name: admin.name, role: 'ADMINISTRATOR', active: true });
  identities.set('engineer', { id: engineer.id, email: engineer.email, name: engineer.name, role: 'MAINTENANCE_ENGINEER', active: true });
  server = createApp(db, undefined, auth).listen(0);
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const adminHeaders = { authorization: 'Bearer admin', 'content-type': 'application/json' };
  const engineerHeaders = { authorization: 'Bearer engineer', 'content-type': 'application/json' };
  const device = await db!.device.findFirstOrThrow({ select: { id: true } });
  const planResponse = await fetch(`${baseUrl}/api/v1/maintenance/plans`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Test monthly inspection', deviceId: device.id, category: 'Inspection', description: 'Dedicated integration test plan', checklist: ['Inspect panel'], frequency: 'MONTHLY', advanceNoticeDays: 7, estimatedDurationMinutes: 45, priority: 'MEDIUM', assignedEngineerId: engineer.id }) });
  assert.equal(planResponse.status, 201);
  const plan = (await planResponse.json() as { data: { id: string } }).data;
  assert.ok(await db!.maintenancePlan.findUnique({ where: { id: plan.id } }));
  const dueAt = new Date(Date.now() - 1000);
  await db!.maintenancePlan.update({ where: { id: plan.id }, data: { nextScheduledAt: dueAt } });
  const maintenance = new MaintenanceService(db!);
  await Promise.all([maintenance.generateDue(), maintenance.generateDue()]);
  assert.equal(await db!.maintenanceWorkOrder.count({ where: { planId: plan.id } }), 1);

  const denied = await fetch(`${baseUrl}/api/v1/maintenance/work-orders`, { method: 'POST', headers: engineerHeaders, body: JSON.stringify({ title: 'Unauthorized', deviceId: device.id, type: 'CORRECTIVE', priority: 'LOW', description: 'Role check', estimatedDurationMinutes: 30 }) });
  assert.equal(denied.status, 403);
  const created = await fetch(`${baseUrl}/api/v1/maintenance/work-orders`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ title: 'Test corrective work', deviceId: device.id, type: 'CORRECTIVE', priority: 'HIGH', description: 'Dedicated work order integration test', estimatedDurationMinutes: 60 }) });
  assert.equal(created.status, 201);
  const order = (await created.json() as { data: { id: string } }).data;
  const assigned = await fetch(`${baseUrl}/api/v1/maintenance/work-orders/${order.id}/assign`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ engineerId: engineer.id }) });
  assert.equal(assigned.status, 200);
  assert.equal((await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: order.id } })).assignedEngineerId, engineer.id);

  const part = await fetch(`${baseUrl}/api/v1/maintenance/work-orders/${order.id}/parts`, { method: 'POST', headers: engineerHeaders, body: JSON.stringify({ partName: 'Bearing', quantity: 3, unitCost: 12.35 }) });
  assert.equal(part.status, 201);
  const cost = await fetch(`${baseUrl}/api/v1/maintenance/work-orders/${order.id}/costs`, { headers: adminHeaders });
  assert.equal(cost.status, 200);
  assert.equal((await cost.json() as { data: { parts: number; total: number } }).data.parts, 37.05);

  const cancelled = await fetch(`${baseUrl}/api/v1/maintenance/work-orders/${order.id}/cancel`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ reason: 'Test cancellation' }) });
  assert.equal(cancelled.status, 200);
  assert.equal((await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: order.id } })).status, 'CANCELLED');
  const history = await fetch(`${baseUrl}/api/v1/maintenance/work-orders/${order.id}/history`, { headers: adminHeaders });
  assert.equal(history.status, 200);
  assert.equal((await history.json() as { data: unknown[] }).data.length, 3);
  const immutable = await fetch(`${baseUrl}/api/v1/maintenance/work-orders/${order.id}/parts`, { method: 'POST', headers: engineerHeaders, body: JSON.stringify({ partName: 'Blocked', quantity: 1, unitCost: 1 }) });
  assert.equal(immutable.status, 409);
});
