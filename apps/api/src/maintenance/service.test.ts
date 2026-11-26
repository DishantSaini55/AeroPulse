import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MaintenanceError, recurrenceDays } from './service.js';

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
