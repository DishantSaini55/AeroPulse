import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateReliability, type AnalyticsInput } from './metrics.js';
import { historicalDemoInput } from './source.js';

test('reliability uses recorded intervals and only available metric samples', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-01-03T00:00:00Z');
  const date = (value: string) => new Date(`2026-01-${value}Z`);
  const input: AnalyticsInput = {
    devices: [{ id: 'device-1', code: 'ILS-P', systemCode: 'ILS', healthyObservedMs: 46 * 3_600_000 }],
    diagnoses: [
      { deviceId: 'device-1', ruleCode: 'MISSING_HEARTBEAT', component: 'Network', confirmedRootCause: 'Connector fault', firstObservedAt: date('01T00:55:00'), detectedAt: date('01T01:00:00'), resolvedAt: date('01T02:00:00') },
      { deviceId: 'device-1', ruleCode: 'MISSING_HEARTBEAT', component: 'Network', confirmedRootCause: 'Connector fault', firstObservedAt: date('02T00:50:00'), detectedAt: date('02T01:00:00'), resolvedAt: date('02T02:00:00') },
    ],
    outages: [{ systemCode: 'ILS', createdAt: date('01T01:00:00'), resolvedAt: date('01T02:00:00') }],
    incidents: [{ deviceId: 'device-1', createdAt: date('01T01:00:00'), acknowledgedAt: date('01T01:10:00'), repairStartedAt: date('01T01:15:00'), repairCompletedAt: date('01T01:45:00') }],
    failovers: [{ systemCode: 'ILS', detectedAt: date('01T01:00:00'), result: 'SUCCESS', durationMs: 800 }, { systemCode: 'ILS', detectedAt: date('02T01:00:00'), result: 'NO_HEALTHY_STANDBY', durationMs: 0 }],
    expenses: [{ deviceId: 'device-1', at: date('01T02:00:00'), amount: 100, kind: 'REPAIR' }, { deviceId: 'device-1', at: date('02T02:00:00'), amount: 50, kind: 'REPLACEMENT' }],
  };
  const result = calculateReliability(input, from, to, 'RECORDED');
  assert.equal(result.summary.failureEpisodes, 2);
  assert.equal(result.summary.mtbfMs, 23 * 3_600_000);
  assert.equal(result.summary.mttdMs, 7.5 * 60_000);
  assert.equal(result.summary.mttaMs, 10 * 60_000);
  assert.equal(result.summary.mttrMs, 30 * 60_000);
  assert.equal(result.summary.equipmentDowntimeMs, 2 * 3_600_000);
  assert.equal(result.summary.serviceDowntimeMs, 3_600_000);
  assert.equal(result.summary.failoverSuccessPct, 50);
  assert.equal(result.summary.maintenanceCost, 150);
  assert.equal(result.summary.recurringFaults, 1);
  assert.ok(Math.abs(result.summary.equipmentAvailabilityPct! - 95.8333333333) < 0.001);
  assert.equal(result.rootCauses[0]?.label, 'Connector fault');
});

test('missing observation and response timestamps remain unavailable instead of fabricated', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-01-02T00:00:00Z');
  const result = calculateReliability({ devices: [{ id: 'new', code: 'NEW-P', systemCode: 'NEW', healthyObservedMs: 0 }], diagnoses: [], outages: [], incidents: [], failovers: [], expenses: [] }, from, to, 'RECORDED');
  assert.equal(result.summary.equipmentAvailabilityPct, null);
  assert.equal(result.summary.serviceAvailabilityPct, null);
  assert.equal(result.summary.mttdMs, null);
  assert.equal(result.summary.mtbfMs, null);
  assert.equal(result.summary.failoverSuccessPct, null);
});

test('unobserved gaps do not inflate the availability denominator', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-01-03T00:00:00Z');
  const report = calculateReliability({ devices: [{ id: 'device-1', code: 'AMSS-P', systemCode: 'AMSS', healthyObservedMs: 10 * 3_600_000 }], diagnoses: [], outages: [], incidents: [], failovers: [], expenses: [] }, from, to, 'RECORDED');
  assert.equal(report.coverage.observedEquipmentMs, 10 * 3_600_000);
  assert.equal(report.summary.equipmentAvailabilityPct, 100);
});

test('historical demo KPIs are calculated from labelled sample events', () => {
  const to = new Date('2026-11-25T12:00:00Z');
  const from = new Date(to.getTime() - 90 * 86_400_000);
  const result = calculateReliability(historicalDemoInput(to), from, to, 'HISTORICAL_DEMO');
  assert.equal(result.dataset, 'HISTORICAL_DEMO');
  assert.ok(result.summary.failureEpisodes >= 8);
  assert.ok(result.summary.mtbfMs !== null);
  assert.ok(result.summary.maintenanceCost > 0);
  assert.ok(result.monthlyTrends.length >= 2);
});
