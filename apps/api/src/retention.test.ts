import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telemetryRetentionDays } from './retention.js';

test('telemetry retention is opt-in and validates its day range', () => {
  assert.equal(telemetryRetentionDays(undefined), null);
  assert.equal(telemetryRetentionDays('30'), 30);
  assert.throws(() => telemetryRetentionDays('0'));
  assert.throws(() => telemetryRetentionDays('30.5'));
  assert.throws(() => telemetryRetentionDays('4000'));
});
