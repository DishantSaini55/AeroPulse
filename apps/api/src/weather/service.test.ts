import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDb, type Database } from '../db.js';
import { WeatherService } from './service.js';

test('weather cache persists real observations and marks failed refresh stale', { skip: !process.env.DATABASE_URL }, async () => {
  const db = createDb();
  let now = new Date('2031-01-01T12:00:00.000Z');
  let calls = 0;
  let failed = false;
  const fetcher: typeof fetch = async (_url, options) => {
    calls++;
    assert.ok(options?.signal);
    assert.match(String((options?.headers as Record<string, string>)?.['User-Agent']), /AeroPulse/);
    if (failed) throw new Error('Network unavailable');
    return new Response(JSON.stringify([{
      icaoId: 'VIDP', obsTime: '2031-01-01T11:30:00.000Z', rawOb: 'METAR VIDP TEST',
      temp: 21, dewp: 8, visib: 1.55, wdir: 240, wspd: 5, altim: 1021, wxString: 'HZ',
    }]), { status: 200 });
  };
  const weather = new WeatherService(db, fetcher, () => now);
  try {
    const first = await weather.getCurrent();
    assert.equal(first.stale, false);
    assert.equal(first.simulated, false);
    assert.equal(first.data?.temperatureC, 21);
    assert.equal(first.data?.rawMetar, 'METAR VIDP TEST');
    assert.equal(first.data?.visibilityMiles, 1.55);
    assert.equal(calls, 1);
    await weather.getCurrent();
    assert.equal(calls, 1);
    now = new Date('2031-01-01T12:06:00.000Z');
    failed = true;
    const fallback = await weather.getCurrent();
    assert.equal(calls, 2);
    assert.equal(fallback.stale, true);
    assert.ok(fallback.staleReasons.includes('UPSTREAM_UNAVAILABLE'));
    assert.equal(fallback.data?.rawMetar, 'METAR VIDP TEST');
    await weather.getCurrent();
    assert.equal(calls, 2);
    now = new Date('2031-01-01T14:01:00.000Z');
    const old = await weather.getCurrent();
    assert.ok(old.staleReasons.includes('OBSERVATION_OUTDATED'));
    assert.ok(old.staleReasons.includes('FETCH_OUTDATED'));
  } finally {
    await db.weatherObservation.deleteMany({ where: { station: 'VIDP', observedAt: new Date('2031-01-01T11:30:00.000Z') } });
    await db.$disconnect();
  }
});

test('empty AWC response with no cached observation returns unavailable state', async () => {
  const db = { weatherObservation: { findFirst: async () => null } } as unknown as Database;
  const weather = new WeatherService(db, async () => new Response(null, { status: 204 }));
  const result = await weather.getCurrent();
  assert.equal(result.data, null);
  assert.equal(result.stale, true);
  assert.ok(result.staleReasons.includes('UPSTREAM_UNAVAILABLE'));
});
