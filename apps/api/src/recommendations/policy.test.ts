import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateRecommendations, recommendationPolicy, type RecommendationInput } from './policy.js';

const at = new Date('2026-11-25T12:00:00.000Z');
const ago = (days: number, minutes = 0) => new Date(at.getTime() - days * 86_400_000 - minutes * 60_000);
const policy = recommendationPolicy({});
const device = { id: 'device-1', code: 'ILS-P', name: 'ILS primary', systemCode: 'ILS', commissionedAt: ago(90), latestReplacementAt: null, latestReplacementCost: null };
const input = (count: number): RecommendationInput => ({ devices: [{ ...device }], faults: Array.from({ length: count }, (_, index) => ({ id: `fault-${index}`, deviceId: device.id, rootCause: 'Loose connector', component: 'Network interface', ruleCode: 'MISSING_HEARTBEAT', detectedAt: ago(25 - index * 5), resolvedAt: ago(25 - index * 5, -20) })), repairs: [] });

test('confirmed same-cause failures escalate at configured thresholds', () => {
  const expected = ['CONTINUE_MONITORING', 'PREVENTIVE_MAINTENANCE', 'DETAILED_INVESTIGATION', 'COMPONENT_REPLACEMENT', 'EQUIPMENT_REPLACEMENT_REVIEW'];
  for (let count = 1; count <= 5; count++) {
    const rows = calculateRecommendations(input(count), at, policy);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.similarFailures, count);
    assert.equal(rows[0]!.action, expected[count - 1]);
  }
});

test('unconfirmed faults, old faults and faults before replacement do not count', () => {
  const source = input(3);
  source.devices[0]!.latestReplacementAt = ago(18);
  source.faults.push({ id: 'unconfirmed', deviceId: device.id, rootCause: null, component: 'Network', ruleCode: 'NETWORK', detectedAt: ago(1), resolvedAt: null });
  source.faults.push({ id: 'old', deviceId: device.id, rootCause: 'Loose connector', component: 'Network', ruleCode: 'NETWORK', detectedAt: ago(40), resolvedAt: ago(39) });
  const rows = calculateRecommendations(source, at, policy);
  assert.equal(rows[0]!.similarFailures, 1);
  assert.equal(rows[0]!.action, 'CONTINUE_MONITORING');
});

test('overlapping rules form one episode and a new repair changes approval evidence', () => {
  const source = input(1);
  source.faults.push({ ...source.faults[0]!, id: 'second-rule', ruleCode: 'NETWORK' });
  const before = calculateRecommendations(source, at, policy)[0]!;
  assert.equal(before.similarFailures, 1);
  assert.equal(before.downtimeMs, 20 * 60_000);
  source.repairs.push({ id: 'repair-1', deviceId: device.id, at: ago(2), cost: 200 });
  const after = calculateRecommendations(source, at, policy)[0]!;
  assert.notEqual(after.evidenceHash, before.evidenceHash);
  assert.equal(after.repairCost, 200);
});

test('component review requires a repeated component, not just a shared root cause', () => {
  const source = input(4);
  source.faults.forEach((fault, index) => { fault.component = `Component ${index}`; });
  assert.equal(calculateRecommendations(source, at, policy)[0]!.action, 'DETAILED_INVESTIGATION');
});

test('invalid policy thresholds fail fast', () => {
  assert.throws(() => recommendationPolicy({ RECOMMENDATION_REPLACEMENT_AT: '2' }));
  assert.throws(() => recommendationPolicy({ RECOMMENDATION_WINDOW_DAYS: 'abc' }));
});
