import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '../db.js';
import { AlarmService, type AlarmNotice } from './service.js';

test('alarm creation is deduplicated, escalation stops after acknowledgement, recovery is informational', async () => {
  const start = new Date('2026-01-01T12:00:00.000Z');
  let diagnosisActive = true;
  const diagnosis = { id: 'diagnosis-1', deviceId: 'device-1', severity: 'WARNING', suspectedCause: 'Possible cooling fault', serviceImpact: 'Active device at risk', detectedAt: start, device: { code: 'TEST-P', name: 'Test primary', system: { name: 'Test system' } } };
  type Stored = { id: string; sourceKey: string; diagnosisId: string | null; deviceId: string; level: string; initialLevel: string; message: string; createdAt: Date; lastEscalatedAt: Date | null; resolvedAt: Date | null; acknowledgements: { userId: string }[]; device: { code: string; name: string } };
  const alarms: Stored[] = [];
  const notices: AlarmNotice[] = [];
  const db = {
    faultDiagnosis: { findMany: async () => diagnosisActive ? [diagnosis] : [] },
    alarm: {
      findUnique: async ({ where }: { where: { sourceKey: string } }) => alarms.find(item => item.sourceKey === where.sourceKey) ?? null,
      findMany: async () => alarms.filter(item => item.resolvedAt === null && item.diagnosisId !== null),
      create: async ({ data }: { data: Omit<Stored, 'id' | 'acknowledgements' | 'device'> }) => {
        const item = { ...data, diagnosisId: data.diagnosisId ?? null, lastEscalatedAt: data.lastEscalatedAt ?? null, resolvedAt: data.resolvedAt ?? null, id: `alarm-${alarms.length + 1}`, acknowledgements: [], device: { code: 'TEST-P', name: 'Test primary' } };
        alarms.push(item); return item;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Stored> }) => Object.assign(alarms.find(item => item.id === where.id)!, data),
    },
  } as unknown as Database;
  const service = new AlarmService(db, notice => notices.push(notice), 15000);
  await service.sync(start);
  await service.sync(new Date(start.getTime() + 5000));
  assert.equal(alarms.length, 1);
  assert.deepEqual(notices.map(item => item.level), ['WARNING']);
  await service.sync(new Date(start.getTime() + 16000));
  assert.equal(alarms[0]?.level, 'MAJOR');
  await service.sync(new Date(start.getTime() + 20000));
  assert.equal(alarms[0]?.level, 'MAJOR');
  alarms[0]!.acknowledgements.push({ userId: 'engineer' });
  await service.sync(new Date(start.getTime() + 31000));
  assert.equal(alarms[0]?.level, 'MAJOR');
  diagnosisActive = false;
  await service.sync(new Date(start.getTime() + 35000));
  assert.equal(alarms[0]?.resolvedAt?.getTime(), start.getTime() + 35000);
  assert.equal(alarms[1]?.level, 'INFORMATION');
  assert.deepEqual(notices.map(item => item.level), ['WARNING', 'MAJOR', 'INFORMATION']);
});
