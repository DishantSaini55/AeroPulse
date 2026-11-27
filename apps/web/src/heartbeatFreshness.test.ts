import { describe, expect, it } from 'vitest';
import { isHeartbeatFresh } from './heartbeatFreshness';

describe('heartbeat freshness from the configured backend timeout', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z');
  const nonDefaultTimeoutMs = 10_000;

  it('uses the configured timeout boundary instead of a frontend default', () => {
    expect(isHeartbeatFresh(new Date(now - 9_999).toISOString(), now, nonDefaultTimeoutMs)).toBe(true);
    expect(isHeartbeatFresh(new Date(now - nonDefaultTimeoutMs).toISOString(), now, nonDefaultTimeoutMs)).toBe(false);
    expect(isHeartbeatFresh(new Date(now - 15_000).toISOString(), now, nonDefaultTimeoutMs)).toBe(false);
  });

  it('treats missing, invalid and future timestamps as not fresh', () => {
    expect(isHeartbeatFresh(null, now, nonDefaultTimeoutMs)).toBe(false);
    expect(isHeartbeatFresh('not-a-date', now, nonDefaultTimeoutMs)).toBe(false);
    expect(isHeartbeatFresh(new Date(now + 1).toISOString(), now, nonDefaultTimeoutMs)).toBe(false);
  });
});
