import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateRecommendations, recommendationPolicy, type RecommendationInput, type MaintenanceEvidence } from './policy.js';

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

const maintenance = (overrides: Partial<MaintenanceEvidence> = {}): MaintenanceEvidence => ({
  id: 'work-1', deviceId: device.id, incidentId: null, type: 'CORRECTIVE', status: 'COMPLETED',
  updatedAt: ago(28), actualStartAt: ago(28,10), completedAt: ago(28), verified: true,
  findings: 'Connector repaired', verificationResult: 'Stable after test', laborCost: '0.20', otherCost: '0.10',
  parts: [{ partName: 'Connector', quantity: 3, unitCost: '0.10' }], ...overrides,
});

test('verified corrective outcomes add exact separate cost evidence and trigger investigation after repeated post-repair failures', () => {
  const source = input(2);
  source.repairs.push({ id: 'legacy-repair', deviceId: device.id, at: ago(1), cost: 5 });
  source.maintenance = [maintenance({ incidentId: 'linked-incident' })];
  const row = calculateRecommendations(source, at, policy)[0]!;
  assert.equal(row.action,'DETAILED_INVESTIGATION');
  assert.equal(row.similarFailures,2);
  assert.equal(row.maintenance.failuresAfterCorrective,2);
  assert.equal(row.maintenance.expenditure,'0.60');
  assert.equal(row.repairCost,5,'Work-order expenditure must not be added to incident repair costs');
  assert.deepEqual(row.maintenance.linkedIncidentIds,['linked-incident']);
  assert.equal(row.maintenance.outcomes[0]!.verificationResult,'Stable after test');
  assert.match(row.rationale,/after corrective maintenance/);
});

test('preventive work, failed verification and expense alone neither invent failures nor escalate replacement', () => {
  const source = input(2);
  source.maintenance = [maintenance({ type: 'PREVENTIVE', laborCost: '9999999.99' }),maintenance({ id: 'failed', verified: false, laborCost: '9999999.99' })];
  const row = calculateRecommendations(source, at, policy)[0]!;
  assert.equal(row.similarFailures,2); assert.equal(row.action,'PREVENTIVE_MAINTENANCE');
  assert.equal(row.maintenance.correctiveCompletions,0);
  source.faults = [];
  assert.deepEqual(calculateRecommendations(source,at,policy),[]);
});

test('maintenance snapshots change review hashes, exclude cancelled/pre-replacement records and count repeated part usage separately', () => {
  const source = input(3);
  source.maintenance = [maintenance(),maintenance({ id: 'work-2', completedAt: ago(20), updatedAt: ago(20) }),maintenance({ id:'cancelled',status:'CANCELLED',laborCost:'10000' })];
  const before = calculateRecommendations(source,at,policy)[0]!;
  assert.equal(before.maintenance.workOrders,2); assert.equal(before.maintenance.expenditure,'1.20');
  assert.deepEqual(before.maintenance.repeatedParts,[{ part:'connector',workOrders:2 }]);
  source.maintenance[0]!.findings = 'Corrected evidence';
  assert.notEqual(calculateRecommendations(source,at,policy)[0]!.evidenceHash,before.evidenceHash);
  source.devices[0]!.latestReplacementAt = ago(18);
  const after = calculateRecommendations(source,at,policy)[0]!;
  assert.equal(after.maintenance.workOrders,0); assert.equal(after.maintenance.failuresAfterCorrective,0);
});

test('recommendation downtime excludes overlapping planned maintenance without excluding real outage time', () => {
  const source = input(1), fault = source.faults[0]!;
  source.maintenance = [maintenance({ type:'PREVENTIVE', actualStartAt: new Date(fault.detectedAt.getTime()+5*60000), completedAt: new Date(fault.detectedAt.getTime()+15*60000),updatedAt:fault.resolvedAt! })];
  assert.equal(calculateRecommendations(source,at,policy)[0]!.downtimeMs,10*60000);
  source.maintenance[0]!.type = 'CORRECTIVE';
  assert.equal(calculateRecommendations(source,at,policy)[0]!.downtimeMs,20*60000);
});
