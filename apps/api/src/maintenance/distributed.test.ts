import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createDb, type Database } from '../db.js';
import { RedundancyManager } from '../failover/manager.js';
import { MaintenanceService } from './service.js';
import { MaintenanceScheduler } from './scheduler.js';
import { AlarmService } from '../alarms/service.js';
import { DiagnosisService } from '../diagnostics/service.js';
import { TelemetryGenerator } from '../simulator/generator.js';
import { calculateReliability } from '../analytics/metrics.js';

const db = process.env.DATABASE_URL ? createDb() : undefined;
const systems: string[] = [];
const policy = { expectedIntervalMs: 5000, missedHeartbeatLimit: 3, timeoutMs: 15000 };
after(async () => {
  if (!db) return;
  const orders = { systemId: { in: systems } };
  const children = { workOrder: orders };
  await db.workOrderChecklistItem.deleteMany({ where: children });
  await db.workOrderPartUsage.deleteMany({ where: children });
  await db.workOrderStatusHistory.deleteMany({ where: children });
  await db.maintenanceWorkOrder.deleteMany({ where: orders });
  await db.maintenancePlan.deleteMany({ where: orders });
  await db.failoverEvent.deleteMany({ where: orders });
  await db.alarm.deleteMany({ where: { device: orders } });
  await db.faultDiagnosis.deleteMany({ where: { device: orders } });
  await db.telemetryReading.deleteMany({ where: { device: orders } });
  await db.heartbeat.deleteMany({ where: { device: orders } });
  await db.device.deleteMany({ where: orders });
  await db.logicalSystem.deleteMany({ where: { id: { in: systems } } });
  await db.$disconnect();
});
async function fixture(type: 'PREVENTIVE' | 'CORRECTIVE' = 'PREVENTIVE', standby = false) {
  const code = 'MC' + crypto.randomUUID().slice(0, 8);
  const system = await db!.logicalSystem.create({ data: { code, name: code } });
  systems.push(system.id);
  const actor = await db!.user.create({ data: { email: code + '@test.local', name: code, role: 'SUPERVISOR', passwordHash: 'test' } });
  const primary = await db!.device.create({ data: { code: code + '-P', name: code, systemId: system.id, role: 'PRIMARY', activationState: 'ACTIVE' } });
  const secondary = await db!.device.create({ data: { code: code + '-S', name: code, systemId: system.id, role: 'SECONDARY' } });
  await db!.heartbeat.createMany({ data: [primary, secondary].map(device => ({ deviceId: device.id })) });
  const order = await db!.maintenanceWorkOrder.create({ data: { occurrenceKey: crypto.randomUUID(), title: code, description: 'Safety integration', type, priority: 'MEDIUM', status: 'ASSIGNED', deviceId: standby ? secondary.id : primary.id, systemId: system.id, estimatedDurationMinutes: 30, supervisorId: actor.id } });
  const changes: unknown[] = [];
  const manager = new RedundancyManager(db!, policy, value => changes.push(value));
  return { system, actor, primary, secondary, order, manager, changes };
}

test('planned failover is atomic, standby-only maintenance does not switch, and approval restores standby eligibility', { skip: !db }, async () => {
  const f = await fixture();
  await f.manager.startMaintenance(f.order.id, f.actor);
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.primary.id } })).maintenanceEligible, false);
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.secondary.id } })).activationState, 'ACTIVE');
  assert.equal(await db!.failoverEvent.count({ where: { systemId: f.system.id, action: 'PLANNED_MAINTENANCE' } }), 1);
  assert.equal(f.changes.length, 1);
  await assert.rejects(db!.device.update({ where: { id: f.primary.id }, data: { activationState: 'ACTIVE' } }));
  await assert.rejects(f.manager.failback(f.system.code, f.actor.id), /not healthy/);
  await db!.maintenanceWorkOrder.update({ where: { id: f.order.id }, data: { status: 'ON_HOLD', verificationResult: 'Failed evidence' } });
  await assert.rejects(f.manager.approveMaintenance(f.order.id, f.actor), /verification/);
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.primary.id } })).maintenanceEligible, false);
  await db!.maintenanceWorkOrder.update({ where: { id: f.order.id }, data: { status: 'VERIFICATION', verificationResult: 'Successful evidence' } });
  await f.manager.approveMaintenance(f.order.id, f.actor);
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.primary.id } })).activationState, 'STANDBY');
  assert.equal((await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'COMPLETED');
  await f.manager.failback(f.system.code, f.actor.id);
  const standby = await fixture('PREVENTIVE', true);
  await standby.manager.startMaintenance(standby.order.id, standby.actor);
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: standby.primary.id } })).activationState, 'ACTIVE');
  assert.equal(await db!.failoverEvent.count({ where: { systemId: standby.system.id } }), 0);
});

test('stale or unavailable standby rejects maintenance; simultaneous starts serialize conflicts', { skip: !db }, async () => {
  const f = await fixture();
  await db!.heartbeat.deleteMany({ where: { deviceId: f.secondary.id } });
  await assert.rejects(f.manager.startMaintenance(f.order.id, f.actor), /fresh heartbeat/);
  await db!.heartbeat.create({ data: { deviceId: f.secondary.id, recordedAt: new Date(Date.now() - 60000) } });
  await assert.rejects(f.manager.startMaintenance(f.order.id, f.actor), /fresh heartbeat/);
  await db!.device.update({ where: { id: f.secondary.id }, data: { health: 'UNAVAILABLE' } });
  await assert.rejects(f.manager.startMaintenance(f.order.id, f.actor), /fresh heartbeat/);
  assert.equal((await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'ASSIGNED');
  assert.equal(f.changes.length, 0);
  const g = await fixture();
  const other = await db!.maintenanceWorkOrder.create({ data: { occurrenceKey: crypto.randomUUID(), title: 'Conflict', description: 'Conflict', type: 'PREVENTIVE', priority: 'HIGH', status: 'ASSIGNED', deviceId: g.secondary.id, systemId: g.system.id, estimatedDurationMinutes: 30 } });
  const results = await Promise.allSettled([g.manager.startMaintenance(g.order.id, g.actor), g.manager.startMaintenance(other.id, g.actor)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await db!.device.count({ where: { systemId: g.system.id, activationState: 'ACTIVE' } }), 1);
});

test('unexpected active failure during maintenance produces outage without unsafe automatic activation', { skip: !db }, async () => {
  const f = await fixture();
  await f.manager.startMaintenance(f.order.id, f.actor);
  await f.manager.check(new Date(Date.now() + 60000), f.system.id);
  assert.equal((await db!.logicalSystem.findUniqueOrThrow({ where: { id: f.system.id } })).availability, 'OUTAGE');
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.primary.id } })).activationState, 'INELIGIBLE');
  assert.equal(await db!.failoverEvent.count({ where: { systemId: f.system.id, action: 'AUTOMATIC_FAILOVER', result: 'NO_HEALTHY_STANDBY' } }), 1);
  await new AlarmService(db!).sync();
  assert.ok(await db!.alarm.count({ where: { device: { systemId: f.system.id }, level: 'CRITICAL' } }));
  const corrective = await db!.maintenanceWorkOrder.create({ data: { occurrenceKey: crypto.randomUUID(), title: 'Outage corrective', description: 'Repair failed inactive device', type: 'CORRECTIVE', status: 'ASSIGNED', priority: 'URGENT', deviceId: f.secondary.id, systemId: f.system.id, estimatedDurationMinutes: 30 } });
  await f.manager.startMaintenance(corrective.id, f.actor);
  assert.equal(await db!.device.count({ where: { systemId: f.system.id, activationState: 'ACTIVE' } }), 0);
  await db!.heartbeat.create({ data: { deviceId: f.secondary.id } });
  await db!.maintenanceWorkOrder.update({ where: { id: corrective.id }, data: { status: 'VERIFICATION', verificationResult: 'Repair verified after outage' } });
  await f.manager.approveMaintenance(corrective.id, f.actor);
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.secondary.id } })).maintenanceEligible, true);
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.secondary.id } })).activationState, 'STANDBY');
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.primary.id } })).maintenanceEligible, false);
  await assert.rejects(f.manager.failback(f.system.code, f.actor.id), /not healthy/);
  await db!.heartbeat.create({ data: { deviceId: f.primary.id } });
  await db!.maintenanceWorkOrder.update({ where: { id: f.order.id }, data: { status: 'VERIFICATION', verificationResult: 'Original maintenance verified' } });
  await f.manager.approveMaintenance(f.order.id, f.actor);
  await f.manager.failback(f.system.code, f.actor.id);
  assert.equal((await db!.logicalSystem.findUniqueOrThrow({ where: { id: f.system.id } })).availability, 'AVAILABLE');
});

test('planned failover rolls back all device, order and event writes after injected audit failure', { skip: !db }, async () => {
  const f = await fixture();
  const injected = db!.$extends({ query: { auditEvent: { async create({ args, query }) { await query(args); throw new Error('INJECTED_AUDIT'); } } } });
  const manager = new RedundancyManager(injected as unknown as Database, policy);
  await assert.rejects(manager.startMaintenance(f.order.id, f.actor), /INJECTED_AUDIT/);
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.primary.id } })).activationState, 'ACTIVE');
  assert.equal((await db!.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'ASSIGNED');
  assert.equal(await db!.failoverEvent.count({ where: { systemId: f.system.id } }), 0);
});

test('scheduler atomically recovers bounded backlog, deduplicates concurrent scans and restarts', { skip: !db }, async () => {
  const f = await fixture();
  const service = new MaintenanceService(db!);
  const plan = await service.createPlan({ name: 'Daily check', deviceId: f.primary.id, category: 'Check', description: 'Daily simulated maintenance', checklist: ['Inspect'], frequency: 'DAILY', advanceNoticeDays: 1, estimatedDurationMinutes: 30, priority: 'LOW' }, f.actor.id);
  const start = new Date(Date.now() - 10 * 86400000);
  await db!.maintenancePlan.update({ where: { id: plan.id }, data: { nextScheduledAt: start } });
  const at = new Date();
  await service.generateDue(at);
  assert.equal(await db!.maintenanceWorkOrder.count({ where: { planId: plan.id } }), 3);
  const next = (await db!.maintenancePlan.findUniqueOrThrow({ where: { id: plan.id } })).nextScheduledAt;
  assert.equal(next.getTime(), start.getTime() + 3 * 86400000);
  await Promise.all([service.generateDue(at), service.generateDue(at)]);
  const rows = await db!.maintenanceWorkOrder.findMany({ where: { planId: plan.id } });
  assert.equal(new Set(rows.map(row => row.occurrenceKey)).size, rows.length);
  let ready = true;
  const scheduler = new MaintenanceScheduler(service, 25, () => ready);
  scheduler.start(); scheduler.start();
  const waitCount = async (expected: number) => {
    const deadline = Date.now() + 15000;
    while (await db!.maintenanceWorkOrder.count({ where: { planId: plan.id } }) < expected && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await db!.maintenanceWorkOrder.count({ where: { planId: plan.id } }), expected);
  };
  await waitCount(11);
  await scheduler.stop();
  ready = false;
  const count = await db!.maintenanceWorkOrder.count({ where: { planId: plan.id } });
  await db!.maintenancePlan.update({ where: { id: plan.id }, data: { nextScheduledAt: new Date(Date.now() - 500) } });
  scheduler.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  await scheduler.stop();
  assert.equal(await db!.maintenanceWorkOrder.count({ where: { planId: plan.id } }), count);
  ready = true; scheduler.start();
  await waitCount(12);
  await scheduler.stop();
  assert.equal(await db!.maintenanceWorkOrder.count({ where: { planId: plan.id } }), 12);
});

test('planned missing heartbeats are not classified as failures and planned time is reported separately', { skip: !db }, async () => {
  const f = await fixture();
  await f.manager.startMaintenance(f.order.id, f.actor);
  const sample = new TelemetryGenerator().next(f.primary.code, 'NORMAL');
  await db!.telemetryReading.create({ data: { deviceId: f.primary.id, ...sample } });
  await new DiagnosisService(db!, policy.timeoutMs).scan(new Date(Date.now() + 60000), f.primary.id);
  assert.equal(await db!.faultDiagnosis.count({ where: { deviceId: f.primary.id } }), 0);
  const start = new Date();
  const end = new Date(start.getTime() + 60000);
  const result = calculateReliability({ devices: [{ id: f.primary.id, code: f.primary.code, systemCode: f.system.code, healthyObservedMs: 0 }],
    diagnoses: [], incidents: [], failovers: [], expenses: [], outages: [],
    plannedMaintenance: [{ deviceId: f.primary.id, start, end }] }, start, end, 'RECORDED');
  assert.equal(result.summary.failureEpisodes, 0);
  assert.equal(result.summary.equipmentDowntimeMs, 0);
  assert.equal(result.summary.plannedEquipmentUnavailabilityMs, 60000);
});

test('scheduler transaction rolls back occurrence creation when schedule advancement fails', { skip: !db }, async () => {
  const f = await fixture();
  const service = new MaintenanceService(db!);
  const plan = await service.createPlan({ name: 'Atomic generation', deviceId: f.primary.id, category: 'Check', description: 'Rollback generation', checklist: ['Inspect'], frequency: 'MONTHLY', advanceNoticeDays: 1, estimatedDurationMinutes: 30, priority: 'LOW' }, f.actor.id);
  const due = new Date(Date.now() - 1000);
  await db!.maintenancePlan.update({ where: { id: plan.id }, data: { nextScheduledAt: due } });
  const injected = db!.$extends({ query: { maintenancePlan: { async update({ args, query }) { const result = await query(args); if (args.where.id === plan.id) throw new Error('INJECTED_ADVANCEMENT_FAILURE'); return result; } } } });
  await assert.rejects(new MaintenanceService(injected as unknown as Database).generateDue(), /INJECTED_ADVANCEMENT_FAILURE/);
  assert.equal(await db!.maintenanceWorkOrder.count({ where: { planId: plan.id } }), 0);
  assert.equal((await db!.maintenancePlan.findUniqueOrThrow({ where: { id: plan.id } })).nextScheduledAt.getTime(), due.getTime());
});

test('scheduler suppresses overlapping ticks and drains its in-flight operation on stop', async () => {
  let release!: () => void;
  let calls = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new MaintenanceScheduler({ generateDue: async () => { calls++; await blocked; return 0; } }, 10);
  scheduler.start(); scheduler.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  release(); await stopping;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});

test('automatic failover excludes activation-ineligible standby even with healthy fresh telemetry', { skip: !db }, async () => {
  const f = await fixture();
  await db!.device.update({ where: { id: f.secondary.id }, data: { maintenanceEligible: false } });
  await db!.heartbeat.deleteMany({ where: { deviceId: f.primary.id } });
  await db!.heartbeat.create({ data: { deviceId: f.primary.id, recordedAt: new Date(Date.now() - 60000) } });
  await f.manager.check(new Date(), f.system.id);
  assert.equal((await db!.device.findUniqueOrThrow({ where: { id: f.secondary.id } })).activationState, 'STANDBY');
  assert.equal((await db!.logicalSystem.findUniqueOrThrow({ where: { id: f.system.id } })).availability, 'OUTAGE');
  assert.equal(await db!.failoverEvent.count({ where: { systemId: f.system.id, result: 'NO_HEALTHY_STANDBY' } }), 1);
});
