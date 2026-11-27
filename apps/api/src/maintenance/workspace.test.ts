import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { Server } from 'node:http';
import { createDb } from '../db.js';
import { createApp } from '../app.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AuthProvider, PublicUser } from '../auth.js';

const db = process.env.DATABASE_URL ? createDb() : undefined;
const actors = new Map<string, PublicUser>();
let server: Server | undefined, base = '', changes = 0;
const marker = 'Workspace-' + crypto.randomUUID().slice(0,8);
const auth: AuthProvider = { login: async () => null, verifyToken: async token => actors.get(token) ?? null };
const call = (path: string, method = 'GET', body?: unknown, token = 'supervisor') => fetch(base + '/api/v1/maintenance/' + path, {
  method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function order(title = marker) {
  const device = await db!.device.findFirstOrThrow();
  const response = await call('work-orders', 'POST', { title, description: 'Workspace integration evidence', deviceId: device.id, type: 'CORRECTIVE', priority: 'HIGH', estimatedDurationMinutes: 60 });
  assert.equal(response.status, 201);
  return (await response.json() as { data: { id: string; deviceId: string; status: string } }).data;
}
before(async () => {
  if (!db) return;
  for (const role of ['SUPERVISOR','MAINTENANCE_ENGINEER'] as const) {
    const user = await db.user.create({ data: { email: marker + role + '@test.local', name: marker + role, role, passwordHash: 'test' } });
    actors.set(role === 'SUPERVISOR' ? 'supervisor' : 'engineer', user);
  }
  server = createApp(db, undefined, auth, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => { changes++; }).listen(0);
  await new Promise<void>(resolve => server!.once('listening',resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  base = 'http://127.0.0.1:' + address.port;
});
after(async () => {
  if (server) await new Promise<void>((resolve,reject) => server!.close(error => error ? reject(error) : resolve()));
  await db?.$disconnect();
});
test('workspace options require authentication and expose active engineers without credentials', { skip: !db }, async () => {
  assert.equal((await call('options','GET',undefined,'invalid')).status,401);
  const response = await call('options');
  assert.equal(response.status,200);
  const result = await response.json() as { data: { devices: { id: string; maintenanceEligible: boolean }[]; engineers: Record<string,unknown>[] } };
  assert.ok(result.data.devices.length >= 20);
  assert.equal(typeof result.data.devices[0]!.maintenanceEligible,'boolean');
  assert.ok(result.data.engineers.some(user => user.id === actors.get('engineer')!.id));
  assert.ok(result.data.engineers.every(user => !('passwordHash' in user) && !('email' in user)));
});
test('workspace work-order search, filters, stable pagination and sorting use persisted rows', { skip: !db }, async () => {
  const rows = await Promise.all([order(marker+' First'),order(marker+' Second'),order(marker+' Third')]);
  const first = await call('workspace/orders?search='+marker+'&limit=2&page=1&sort=created&direction=asc');
  assert.equal(first.status,200);
  const a = await first.json() as { data: { id: string }[]; total: number };
  const b = await (await call('workspace/orders?search='+marker+'&limit=2&page=2&sort=created&direction=asc')).json() as typeof a;
  assert.equal(a.total,3); assert.equal(a.data.length,2); assert.equal(b.data.length,1);
  assert.deepEqual([...a.data,...b.data].map(row => row.id).sort(),rows.map(row => row.id).sort());
  await call('work-orders/'+rows[0]!.id+'/assign','POST',{ engineerId: actors.get('engineer')!.id });
  const assigned = await (await call('workspace/orders?search='+marker+'&status=ASSIGNED')).json() as typeof a;
  assert.equal(assigned.total,1); assert.equal(assigned.data[0]!.id,rows[0]!.id);
  assert.equal((await call('workspace/orders?sort=unknown')).status,400);
});
test('plan editing preserves omitted values, validates engineers and moves future work to the selected device system', { skip: !db }, async () => {
  const first = await db!.device.findFirstOrThrow();
  const second = await db!.device.findFirstOrThrow({ where: { systemId: { not: first.systemId } } });
  const response = await call('plans','POST',{ name: marker, deviceId: first.id, category: 'Inspection', description: 'Template edit test', checklist: ['Inspect original'],
    frequency: 'MONTHLY', advanceNoticeDays: 13, estimatedDurationMinutes: 90, priority: 'HIGH', assignedEngineerId: actors.get('engineer')!.id });
  assert.equal(response.status,201);
  const plan = (await response.json() as { data: { id: string } }).data;
  assert.equal((await call('plans/'+plan.id,'PATCH',{ active: false })).status,200);
  const persisted = await db!.maintenancePlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal(persisted.priority,'HIGH'); assert.equal(persisted.advanceNoticeDays,13); assert.equal(persisted.active,false);
  assert.equal((await call('plans/'+plan.id,'PATCH',{ deviceId: second.id, assignedEngineerId: null })).status,200);
  const moved = await db!.maintenancePlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal(moved.systemId,second.systemId); assert.equal(moved.assignedEngineerId,null);
  assert.equal((await call('plans/'+plan.id,'PATCH',{ assignedEngineerId: actors.get('supervisor')!.id })).status,409);
  assert.equal((await call('plans/'+plan.id,'PATCH',{ frequency: 'CUSTOM' })).status,409);
  assert.equal((await call('plans/'+plan.id,'PATCH',{ active: true },'engineer')).status,403);
});
test('readiness previews describe resource authorization and retain authoritative freshness evidence', { skip: !db }, async () => {
  const row = await order(marker+' Readiness');
  const response = await call('work-orders/'+row.id+'/readiness','GET',undefined,'engineer');
  assert.equal(response.status,200);
  const { data } = await response.json() as { data: { canStart: boolean; blockingReasons: string[]; previewOnly: boolean; devices: unknown[] } };
  assert.equal(data.canStart,false); assert.equal(data.previewOnly,true); assert.equal(data.devices.length,2);
  assert.ok(data.blockingReasons.some(reason => reason.includes('assigned engineer')));
  assert.equal((await call('work-orders/invalid/readiness')).status,400);
});
test('Decimal part, labor and other totals are exact and cost mutations enforce ownership and finalization', { skip: !db }, async () => {
  const row = await order(marker+' Costs');
  assert.equal((await call('work-orders/'+row.id+'/parts','POST',{ partName: 'Decimal sample', quantity: 3, unitCost: .1 })).status,201);
  assert.equal((await call('work-orders/'+row.id+'/costs','PATCH',{ laborCost: .2, otherCost: .1 },'engineer')).status,403);
  assert.equal((await call('work-orders/'+row.id+'/costs','PATCH',{ laborCost: .2, otherCost: .1 })).status,200);
  const total = await (await call('work-orders/'+row.id+'/costs')).json() as { data: { total: number; parts: number } };
  assert.equal(total.data.parts,.3); assert.equal(total.data.total,.6);
  assert.equal((await call('work-orders/'+row.id+'/costs','PATCH',{ laborCost: .123, otherCost: 0 })).status,400);
  await call('work-orders/'+row.id+'/cancel','POST',{ reason: 'Finalized cost protection' });
  assert.equal((await call('work-orders/'+row.id+'/costs','PATCH',{ laborCost: 8, otherCost: 9 })).status,409);
  assert.equal(Number((await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: row.id } })).laborCost),.2);
  assert.ok(changes >= 3, 'Committed maintenance mutations must invalidate other viewers');
});
test('overview and calendar return real cohorts, precise expenditure and explicit insufficient-data results', { skip: !db }, async () => {
  const far = await call('overview?from=2099-01-01&to=2099-01-02');
  assert.equal(far.status,200);
  const empty = (await far.json() as { data: { compliance: { denominator: number; percent: number|null }; averageCompletionMs: number|null; totalExpenditure: string } }).data;
  assert.equal(empty.compliance.denominator,0); assert.equal(empty.compliance.percent,null); assert.equal(empty.averageCompletionMs,null); assert.equal(empty.totalExpenditure,'0.00');
  const actual = await call('overview'); assert.equal(actual.status,200);
  const summary = (await actual.json() as { data: { totalExpenditure: string; formulas: Record<string,string> } }).data;
  assert.ok(Number(summary.totalExpenditure) >= .6); assert.ok(summary.formulas.expenditure); assert.ok(summary.formulas.expenditure.includes('Decimal'));
  const calendar = await call('calendar'); assert.equal(calendar.status,200);
  assert.equal((await call('overview?from=2026-03-01&to=2026-01-01')).status,400);
});

test('compliance uses due non-cancelled orders and completion mean uses real recorded durations', { skip: !db }, async () => {
  const day = new Date(Date.now()-86400000).toISOString().slice(0,10), today = new Date().toISOString().slice(0,10);
  const path = 'overview?from='+day+'&to='+today;
  type Summary = { compliance: { numerator: number; denominator: number }; averageCompletionMs: number|null; completionSamples: number; totalExpenditure: string };
  const before = (await (await call(path)).json() as { data: Summary }).data;
  const device = await db!.device.findFirstOrThrow();
  for (const [index,status,hour] of [[0,'COMPLETED',12.5],[1,'COMPLETED',14],[2,'CANCELLED',0]] as const) {
    const start = new Date(day+'T12:00:00.000Z'), deadline = new Date(day+'T13:00:00.000Z');
    await db!.maintenanceWorkOrder.create({ data: { occurrenceKey: crypto.randomUUID(), title: marker+' Compliance '+index, description: 'Persisted timing denominator', type: 'PREVENTIVE',
      priority: 'LOW', status, deviceId: device.id, systemId: device.systemId, scheduledStartAt: start, scheduledCompletionAt: deadline,
      actualStartAt: status === 'COMPLETED' ? start : undefined, completedAt: status === 'COMPLETED' ? new Date(start.getTime()+(hour-12)*3600000) : undefined,
      estimatedDurationMinutes: 60, laborCost: status === 'COMPLETED' ? '.60' : '0' } });
  }
  const after = (await (await call(path)).json() as { data: Summary }).data;
  assert.equal(after.compliance.denominator,before.compliance.denominator+2);
  assert.equal(after.compliance.numerator,before.compliance.numerator+1);
  assert.equal(after.completionSamples,before.completionSamples+2);
  const mean = ((before.averageCompletionMs??0)*before.completionSamples+1800000+7200000)/(before.completionSamples+2);
  assert.ok(Math.abs(after.averageCompletionMs!-mean)<.00001);
  assert.equal(after.totalExpenditure,new Prisma.Decimal(before.totalExpenditure).plus('1.20').toFixed(2));
});
