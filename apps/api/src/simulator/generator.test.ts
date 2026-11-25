import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelemetryGenerator } from './generator.js';

test('equipment type determines available measurements', () => {
  const generator = new TelemetryGenerator();
  const server = generator.next('AMSS-P');
  const ups = generator.next('UPS-P');
  const radio = generator.next('VHF-P');
  assert.equal(typeof server.cpuPercent, 'number');
  assert.equal(server.voltageV, undefined);
  assert.equal(typeof ups.voltageV, 'number');
  assert.equal(ups.cpuPercent, undefined);
  assert.equal(typeof radio.signalPct, 'number');
});

test('degradation and failure have correlated symptoms and recover gradually', () => {
  const generator = new TelemetryGenerator();
  const normal = generator.next('RADAR-P');
  let degraded = normal;
  for (let i = 0; i < 8; i++) degraded = generator.next('RADAR-P', 'DEGRADATION');
  assert.ok(degraded.temperatureC! > normal.temperatureC!);
  assert.ok(degraded.fanRpm! < normal.fanRpm!);
  assert.ok(degraded.packetLossPct! > normal.packetLossPct!);
  let failed = degraded;
  for (let i = 0; i < 12; i++) failed = generator.next('RADAR-P', 'FAILURE');
  assert.ok(failed.temperatureC! > degraded.temperatureC!);
  assert.ok(failed.signalPct! < degraded.signalPct!);
  const firstRecovery = generator.next('RADAR-P', 'RECOVERY');
  assert.ok(firstRecovery.temperatureC! < failed.temperatureC!);
  assert.ok(firstRecovery.temperatureC! > normal.temperatureC!);
  let recovered = firstRecovery;
  for (let i = 0; i < 30; i++) recovered = generator.next('RADAR-P', 'RECOVERY');
  assert.ok(recovered.temperatureC! < firstRecovery.temperatureC!);
});
