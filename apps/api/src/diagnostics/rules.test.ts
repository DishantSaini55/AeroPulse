import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose } from './rules.js';

test('normal telemetry produces no suspected fault', () => {
  assert.deepEqual(diagnose({ temperatureC: 32, fanRpm: 2400, cpuPercent: 30, memoryPercent: 40, latencyMs: 8, packetLossPct: 0.1 }, false), []);
});

test('correlated high temperature and low fan speed suggest a fan fault', () => {
  const findings = diagnose({ temperatureC: 82, fanRpm: 400 }, false);
  assert.deepEqual(findings.map(item => item.ruleCode), ['COOLING_FAN']);
  assert.deepEqual(findings[0]?.supportingTelemetry, { temperatureC: 82, fanRpm: 400 });
});

test('multiple symptoms can yield ambiguous suspected causes', () => {
  const findings = diagnose({ cpuPercent: 94, memoryPercent: 92, latencyMs: 210, packetLossPct: 35 }, false);
  assert.deepEqual(findings.map(item => item.ruleCode), ['RESOURCE_OVERLOAD', 'NETWORK_DEGRADATION']);
});

test('missing heartbeat without packet evidence stays unknown', () => {
  const findings = diagnose({}, true);
  assert.equal(findings[0]?.suspectedCause, 'Unknown cause of missing heartbeat');
  assert.equal(findings[0]?.severity, 'CRITICAL');
});
