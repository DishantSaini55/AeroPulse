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
const request = async (path: string, method = 'GET', body?: unknown, token = 'admin') => fetch(baseUrl + '/api/v1/maintenance/' + path, {
  method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const fixture = async (status: 'ASSIGNED' | 'VERIFICATION' | 'COMPLETED' | 'CANCELLED' | 'DRAFT' = 'ASSIGNED') => {
  const device = await db!.device.findFirstOrThrow();
  return db!.maintenanceWorkOrder.create({ data: {
    occurrenceKey: 'test:' + crypto.randomUUID(), title: 'Coverage fixture', description: 'Maintenance test evidence',
    deviceId: device.id, systemId: device.systemId, type: 'INSPECTION', priority: 'MEDIUM', estimatedDurationMinutes: 30,
    status, assignedEngineerId: identities.get('engineer')!.id,
    checklistItems: { create: { description: 'Original inspection' } },
    parts: { create: { partName: 'Original part', quantity: 1, unitCost: 0.1 } },
  }, include: { checklistItems: true, parts: true } });
};
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
  const supervisor = await db!.user.create({ data: { email: 'supervisor-' + suffix + '@example.test', name: 'Test Supervisor', passwordHash: 'test-hash', role: 'SUPERVISOR' } });
  identities.set('supervisor', { ...supervisor, role: 'SUPERVISOR' });
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

test('plan updates toggle active state and preserve historical checklist snapshots', { skip: !db }, async () => {
  const plan = await db!.maintenancePlan.findFirstOrThrow({ where: { createdById: identities.get('admin')!.id } });
  const order = await db!.maintenanceWorkOrder.findFirstOrThrow({ where: { planId: plan.id }, include: { checklistItems: true } });
  const snapshot = order.checklistItems.map(item => item.description);
  for (const active of [false, true]) {
    const response = await request('plans/' + plan.id, 'PATCH', { active, name: 'Updated template', checklist: ['New template instruction'] });
    assert.equal(response.status, 200);
    assert.equal((await db!.maintenancePlan.findUniqueOrThrow({ where: { id: plan.id } })).active, active);
  }
  assert.deepEqual((await db!.workOrderChecklistItem.findMany({ where: { workOrderId: order.id } })).map(item => item.description), snapshot);
  assert.equal((await request('plans/' + plan.id, 'PATCH', { active: false }, 'engineer')).status, 403);
});

test('checklists and findings persist; verification rejects incomplete and failed results', { skip: !db }, async () => {
  const order = await fixture();
  const path = 'work-orders/' + order.id;
  assert.equal((await request(path + '/verify', 'POST', { passed: true, remarks: 'Evidence checked' }, 'engineer')).status, 409);
  for (const result of ['FAILED', 'PASSED']) {
    assert.equal((await request(path + '/checklist/' + order.checklistItems[0]!.id, 'PATCH', { result, remarks: 'Recorded evidence' }, 'engineer')).status, 200);
    assert.equal((await request(path + '/verify', 'POST', { passed: true, remarks: 'Evidence checked' }, 'engineer')).status, result === 'FAILED' ? 409 : 200);
  }
  assert.equal((await request(path + '/findings', 'PATCH', { findings: 'Panel inspected and secure' }, 'engineer')).status, 200);
  const persisted = await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: order.id }, include: { checklistItems: true } });
  assert.equal(persisted.status, 'VERIFICATION');
  assert.equal(persisted.findings, 'Panel inspected and secure');
  assert.equal(persisted.checklistItems[0]!.completedById, identities.get('engineer')!.id);
  const failed = await fixture();
  await db!.workOrderChecklistItem.updateMany({ where: { workOrderId: failed.id }, data: { completed: true, result: 'NOT_APPLICABLE' } });
  assert.equal((await request('work-orders/' + failed.id + '/verify', 'POST', { passed: false, remarks: 'Operational evidence failed' }, 'engineer')).status, 200);
  assert.equal((await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: failed.id } })).status, 'ON_HOLD');
});

test('supervisor decisions require role, lifecycle and reason; approval keeps activation blocked', { skip: !db }, async () => {
  const order = await fixture('VERIFICATION');
  const path = 'work-orders/' + order.id;
  for (const action of ['approve', 'reject']) assert.equal((await request(path + '/' + action, 'POST', { reason: 'Needs reinspection' }, 'engineer')).status, 403);
  assert.equal((await request(path + '/reject', 'POST', { reason: '' })).status, 400);
  assert.equal((await request(path + '/reject', 'POST', { reason: 'Needs reinspection' }, 'supervisor')).status, 200);
  const rejected = await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: order.id }, include: { transitions: true } });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.cancellationReason, 'Needs reinspection');
  assert.equal(rejected.transitions[0]!.fromStatus, 'VERIFICATION');
  assert.equal((await request(path + '/reject', 'POST', { reason: 'Repeated request' })).status, 409);
  const approval = await fixture('VERIFICATION');
  const before = await db!.device.findUniqueOrThrow({ where: { id: approval.deviceId } });
  const approved = await request('work-orders/' + approval.id + '/approve', 'POST', {}, 'supervisor');
  assert.equal(approved.status, 409);
  assert.equal((await approved.json() as { error: { code: string } }).error.code, 'ACTIVATION_SAFETY_PENDING');
  assert.equal((await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: approval.id } })).status, 'ON_HOLD');
  assert.deepEqual(await db!.device.findUniqueOrThrow({ where: { id: approval.deviceId } }), before);
});

test('cross-order checklist and part identifiers cannot mutate foreign resources', { skip: !db }, async () => {
  const [first, second] = await Promise.all([fixture(), fixture()]);
  const path = 'work-orders/' + first.id;
  assert.equal((await request(path + '/checklist/' + second.checklistItems[0]!.id, 'PATCH', { result: 'PASSED' })).status, 404);
  assert.equal((await request(path + '/parts/' + second.parts[0]!.id, 'PATCH', { partName: 'Attack', quantity: 2, unitCost: 10 })).status, 404);
  assert.equal((await request(path + '/parts/' + second.parts[0]!.id, 'DELETE')).status, 404);
  assert.equal((await db!.workOrderChecklistItem.findUniqueOrThrow({ where: { id: second.checklistItems[0]!.id } })).completed, false);
  assert.equal((await db!.workOrderPartUsage.findUniqueOrThrow({ where: { id: second.parts[0]!.id } })).partName, 'Original part');
  const third = await db!.user.create({ data: { email: crypto.randomUUID() + '@test.local', name: 'Other engineer', role: 'MAINTENANCE_ENGINEER', passwordHash: 'test' } });
  identities.set('other', { ...third, role: 'MAINTENANCE_ENGINEER' });
  const forbidden = await request(path + '/findings', 'PATCH', { findings: 'Unauthorized change' }, 'other');
  assert.equal(forbidden.status, 403);
  const deniedMutations: Array<[string, string, unknown]> = [
    ['/checklist/' + first.checklistItems[0]!.id, 'PATCH', { result: 'PASSED' }],
    ['/verify', 'POST', { passed: true, remarks: 'Unauthorized verify' }],
    ['/parts/' + first.parts[0]!.id, 'PATCH', { partName: 'Attack', quantity: 2, unitCost: 1 }],
    ['/parts/' + first.parts[0]!.id, 'DELETE', undefined],
  ];
  for (const [suffix, method, body] of deniedMutations) assert.equal((await request(path + suffix, method, body, 'other')).status, 403);
  assert.equal((await request(path + '/parts', 'POST', { partName: 'Attack', quantity: 1, unitCost: 1 }, 'other')).status, 409);
  assert.equal((await request(path + '/findings', 'PATCH', { findings: 'No authentication' }, 'unknown-token')).status, 401);
});

test('completed and cancelled orders reject every mounted mutation and preserve all records', { skip: !db }, async () => {
  for (const status of ['COMPLETED', 'CANCELLED'] as const) {
    const order = await fixture(status);
    const path = 'work-orders/' + order.id;
    const actions: Array<[string, string, unknown]> = [
      ['/assign', 'POST', { engineerId: identities.get('engineer')!.id }], ['/cancel', 'POST', { reason: 'Cannot change' }],
      ['/checklist/' + order.checklistItems[0]!.id, 'PATCH', { result: 'PASSED' }], ['/findings', 'PATCH', { findings: 'Cannot change' }],
      ['/parts', 'POST', { partName: 'Blocked', quantity: 1, unitCost: 1 }],
      ['/parts/' + order.parts[0]!.id, 'PATCH', { partName: 'Blocked', quantity: 2, unitCost: 1 }],
      ['/parts/' + order.parts[0]!.id, 'DELETE', undefined], ['/verify', 'POST', { passed: true, remarks: 'Cannot change' }],
      ['/approve', 'POST', {}], ['/reject', 'POST', { reason: 'Cannot change' }],
    ];
    for (const [suffix, method, body] of actions) assert.equal((await request(path + suffix, method, body)).status, 409, status + suffix);
    assert.deepEqual(await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: order.id }, include: { checklistItems: true, parts: true } }), order);
    assert.equal(await db!.workOrderStatusHistory.count({ where: { workOrderId: order.id } }), 0);
  }
});

test('concurrent cancellation and assignment serialize lifecycle history', { skip: !db }, async () => {
  const order = await fixture('DRAFT');
  const path = 'work-orders/' + order.id;
  const responses = await Promise.all([
    request(path + '/assign', 'POST', { engineerId: identities.get('engineer')!.id }),
    request(path + '/cancel', 'POST', { reason: 'Concurrent cancellation' }),
  ]);
  assert.equal(responses[1]!.status, 200);
  assert.ok([200, 409].includes(responses[0]!.status));
  const persisted = await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: order.id }, include: { transitions: { orderBy: { createdAt: 'asc' } } } });
  assert.equal(persisted.status, 'CANCELLED');
  assert.equal(persisted.transitions.length, responses[0]!.status === 200 ? 2 : 1);
  assert.equal(persisted.transitions.at(-1)!.toStatus, 'CANCELLED');
});

test('maintenance inputs cannot alter device health, activation or restore eligibility', { skip: !db }, async () => {
  const order = await fixture();
  const before = await db!.device.findUniqueOrThrow({ where: { id: order.deviceId } });
  for (const field of ['activationState', 'health', 'eligibleForActivation']) {
    const response = await request('work-orders/' + order.id + '/findings', 'PATCH', { findings: 'Attempted privilege escalation', [field]: field === 'health' ? 'HEALTHY' : 'ACTIVE' });
    assert.equal(response.status, 400);
  }
  assert.equal((await request('work-orders/' + order.id + '/start', 'POST', {}, 'other')).status, 403);
  assert.equal((await request('work-orders/' + order.id + '/complete', 'POST', {})).status, 404);
  assert.deepEqual(await db!.device.findUniqueOrThrow({ where: { id: order.deviceId } }), before);
});

test('concurrent verification records one transition; concurrent cancellation fences part writes', { skip: !db }, async () => {
  const order = await fixture();
  await db!.workOrderChecklistItem.updateMany({ where: { workOrderId: order.id }, data: { completed: true, result: 'PASSED' } });
  const path = 'work-orders/' + order.id;
  const verified = await Promise.all([request(path + '/verify', 'POST', { passed: true, remarks: 'First verification' }), request(path + '/verify', 'POST', { passed: true, remarks: 'Second verification' })]);
  assert.deepEqual(verified.map(value => value.status).sort(), [200, 409]);
  assert.equal(await db!.workOrderStatusHistory.count({ where: { workOrderId: order.id } }), 1);
  const racing = await fixture();
  const racePath = 'work-orders/' + racing.id;
  const [cancel, part] = await Promise.all([request(racePath + '/cancel', 'POST', { reason: 'Fence mutations' }), request(racePath + '/parts', 'POST', { partName: 'Race part', quantity: 1, unitCost: 1 })]);
  assert.equal(cancel.status, 200);
  assert.ok([201, 409].includes(part.status));
  assert.equal(await db!.workOrderPartUsage.count({ where: { workOrderId: racing.id } }), part.status === 201 ? 2 : 1);
  assert.equal((await request(racePath + '/parts', 'POST', { partName: 'Late part', quantity: 1, unitCost: 1 })).status, 409);
});

test('mounted cancellation rolls back database writes on controlled history failure', { skip: !db }, async () => {
  const order = await fixture();
  const injected = db!.$extends({ query: { workOrderStatusHistory: { async create({ args, query }) { await query(args); throw new Error('INJECTED_API_HISTORY_FAILURE'); } } } });
  const isolatedServer = createApp(injected as unknown as NonNullable<typeof db>, undefined, auth).listen(0);
  try {
    await new Promise<void>(resolve => isolatedServer.once('listening', resolve));
    const address = isolatedServer.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/v1/maintenance/work-orders/' + order.id + '/cancel', {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Injected failure' }),
    });
    assert.equal(response.status, 500);
    assert.equal((await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: order.id } })).status, 'ASSIGNED');
    assert.equal(await db!.workOrderStatusHistory.count({ where: { workOrderId: order.id } }), 0);
  } finally { await new Promise<void>((resolve, reject) => isolatedServer.close(error => error ? reject(error) : resolve())); }
});
