import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '../db.js';
import { DiagnosisService } from './service.js';

test('diagnosis stores the first telemetry symptom and first missed heartbeat for MTTD', async () => {
  const at = new Date('2026-01-01T12:00:20Z');
  const sampleAt = new Date('2026-01-01T12:00:19Z');
  const lastHeartbeat = new Date('2026-01-01T12:00:00Z');
  const created: Array<{ ruleCode: string; firstObservedAt: Date }> = [];
  const db = {
    device: { findMany: async () => [{ id: 'device-1', systemId: 'system-1', activationState: 'ACTIVE', createdAt: lastHeartbeat,
      telemetry: [{ recordedAt: sampleAt, temperatureC: 85, fanRpm: 300, packetLossPct: 0 }], heartbeats: [{ recordedAt: lastHeartbeat }], system: { availability: 'AVAILABLE' } }] },
    faultDiagnosis: { findMany: async () => [], create: async ({ data }: { data: { ruleCode: string; firstObservedAt: Date } }) => { created.push(data); return data; } },
  } as unknown as Database;
  await new DiagnosisService(db, 15_000, 5000).scan(at);
  assert.equal(created.find(item => item.ruleCode === 'COOLING_FAN')?.firstObservedAt.getTime(), sampleAt.getTime());
  assert.equal(created.find(item => item.ruleCode === 'MISSING_HEARTBEAT')?.firstObservedAt.getTime(), lastHeartbeat.getTime() + 5000);
});
