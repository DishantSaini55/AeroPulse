import { z } from 'zod';
import type { Database } from '../db.js';

export const WEATHER_URL = 'https://aviationweather.gov/api/data/metar?ids=VIDP&format=json';
const REFRESH_MS = 5 * 60_000;
const FETCH_STALE_MS = 10 * 60_000;
const OBSERVATION_STALE_MS = 2 * 60 * 60_000;
const TIMEOUT_MS = 8_000;

const metarSchema = z.object({
  icaoId: z.string(),
  obsTime: z.union([z.number(), z.string()]),
  rawOb: z.string().min(1),
  temp: z.unknown().optional(),
  dewp: z.unknown().optional(),
  visib: z.unknown().optional(),
  wspd: z.unknown().optional(),
  wdir: z.unknown().optional(),
  altim: z.unknown().optional(),
  wxString: z.unknown().optional(),
});

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\d+(\.\d+)?\+?$/.test(value)) return Number.parseFloat(value);
  return null;
};

function observationDate(value: number | string) {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid METAR observation time');
  return date;
}

export class WeatherService {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private latest?: Awaited<ReturnType<Database['weatherObservation']['findFirst']>>;
  private loaded = false;
  private lastAttemptAt = 0;
  private lastError: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCurrent() {
    if (!this.loaded) {
      this.latest = await this.db.weatherObservation.findFirst({
        where: { station: 'VIDP' }, orderBy: { fetchedAt: 'desc' },
      });
      this.loaded = true;
    }
    const now = this.now();
    const lastSuccessfulFetch = this.latest?.fetchedAt.getTime() ?? 0;
    if (now.getTime() - lastSuccessfulFetch >= REFRESH_MS && now.getTime() - this.lastAttemptAt >= REFRESH_MS) {
      await this.refresh();
    }
    const reasons: string[] = [];
    if (!this.latest || now.getTime() - this.latest.fetchedAt.getTime() > FETCH_STALE_MS) reasons.push('FETCH_OUTDATED');
    if (this.latest && now.getTime() - this.latest.observedAt.getTime() > OBSERVATION_STALE_MS) reasons.push('OBSERVATION_OUTDATED');
    if (this.lastError) reasons.push('UPSTREAM_UNAVAILABLE');
    return {
      source: 'AVIATION_WEATHER_CENTER' as const,
      station: 'VIDP',
      simulated: false,
      stale: reasons.length > 0,
      staleReasons: reasons,
      lastError: this.lastError,
      data: this.latest ?? null,
    };
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchAndPersist().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async fetchAndPersist() {
    this.lastAttemptAt = this.now().getTime();
    try {
      const response = await this.fetcher(WEATHER_URL, {
        headers: { 'User-Agent': 'AeroPulsePortfolio/0.5 (simulated-infrastructure-weather)', Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 204) throw new Error('No METAR currently available');
      if (!response.ok) throw new Error(`AWC returned HTTP ${response.status}`);
      const payload = await response.json() as unknown;
      if (!Array.isArray(payload)) throw new Error('Invalid METAR response');
      const entry = payload.map((item) => metarSchema.safeParse(item)).find((result) => result.success && result.data.icaoId === 'VIDP');
      if (!entry?.success) throw new Error('VIDP METAR not found');
      const metar = entry.data;
      const fetchedAt = this.now();
      const observedAt = observationDate(metar.obsTime);
      const values = {
        rawMetar: metar.rawOb,
        temperatureC: numberOrNull(metar.temp),
        dewPointC: numberOrNull(metar.dewp),
        visibilityMiles: numberOrNull(metar.visib),
        windSpeedKnots: numberOrNull(metar.wspd),
        windDirectionDeg: numberOrNull(metar.wdir),
        pressureHpa: numberOrNull(metar.altim),
        conditions: typeof metar.wxString === 'string' ? metar.wxString : null,
        fetchedAt,
      };
      this.latest = await this.db.weatherObservation.upsert({
        where: { station_observedAt: { station: 'VIDP', observedAt } },
        create: { station: 'VIDP', observedAt, ...values },
        update: values,
      });
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Weather fetch failed';
    }
  }

  start() {
    if (this.timer) return;
    void this.getCurrent().catch((error: unknown) => console.error('Weather cache load failed', error));
    this.timer = setInterval(() => {
      void this.getCurrent().catch((error: unknown) => console.error('Weather refresh failed', error));
    }, REFRESH_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}
