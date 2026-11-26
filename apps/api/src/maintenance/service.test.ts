import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MaintenanceError, MaintenanceService, recurrenceDays } from './service.js';
import { createDb, type Database } from '../db.js';

test('maintenance recurrence intervals are stable and custom intervals are validated by callers', () => {
  assert.deepEqual(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'].map(value => recurrenceDays(value)), [1, 7, 30, 91, 182, 365]);
  assert.equal(recurrenceDays('CUSTOM', 14), 14);
  assert.equal(recurrenceDays('CUSTOM'), 0);
  assert.equal(recurrenceDays('unknown'), 0);
});

test('maintenance service errors preserve machine readable codes', () => {
  const error = new MaintenanceError('INVALID_TRANSITION', 'Invalid state change');
  assert.equal(error.code, 'INVALID_TRANSITION');
  assert.equal(error.message, 'Invalid state change');
});

test('PostgreSQL rolls back lifecycle state and history when an injected history write fails', { skip: !process.env.DATABASE_URL }, async () => {
  const db = createDb();
  try {
    const device = await db.device.findFirstOrThrow();
    const actor = await db.user.findFirstOrThrow({ where: { role: 'ADMINISTRATOR', active: true } });
    const order = await db.maintenanceWorkOrder.create({ data: { occurrenceKey: crypto.randomUUID(), title: 'Rollback test', description: 'Controlled transaction failure', deviceId: device.id, systemId: device.systemId, type: 'INSPECTION', priority: 'LOW', estimatedDurationMinutes: 10 } });
    const injected = db.$extends({ query: { workOrderStatusHistory: { async create({ args, query }) {
      await query(args);
      throw new Error('INJECTED_HISTORY_FAILURE');
    } } } });
    const service = new MaintenanceService(injected as unknown as Database);
    await assert.rejects(service.transition(order.id, 'SCHEDULED', actor), /INJECTED_HISTORY_FAILURE/);
    assert.equal((await db.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: order.id } })).status, 'DRAFT');
    assert.equal(await db.workOrderStatusHistory.count({ where: { workOrderId: order.id } }), 0);
    const normal = new MaintenanceService(db);
    await assert.rejects(normal.transition(order.id, 'IN_PROGRESS', actor), /Prompt 4C/);
    await assert.rejects(normal.transition(order.id, 'COMPLETED', actor), /Prompt 4C/);
    assert.equal((await db.maintenanceWorkOrder.findUniqueOrThrow({ where: { id: order.id } })).status, 'DRAFT');
  } finally { await db.$disconnect(); }
});
