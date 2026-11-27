// Local, read-only load probe. Set BENCH_URL and BENCH_TOKEN to an isolated runtime.
import { performance } from 'node:perf_hooks';

const base = process.env.BENCH_URL;
const token = process.env.BENCH_TOKEN;
if (!base || !token) throw new Error('BENCH_URL and BENCH_TOKEN are required');
const origin = new URL(base);
if (!['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('Benchmark target must be loopback');
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 5);
const requests = Number(process.env.BENCH_REQUESTS ?? 100);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20 || !Number.isInteger(requests) || requests < 1 || requests > 1000) throw new Error('Invalid bounded benchmark settings');
const path = process.env.BENCH_PATH ?? '/api/v1/notifications?limit=20';
if (!['/api/v1/notifications?limit=20', '/api/v1/monitoring/snapshot', '/api/v1/alarms?limit=20'].includes(path)) throw new Error('Only read-only benchmark paths are allowed');
const durations = [];
const statuses = new Map();
let next = 0;
const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (;;) {
    const index = next++;
    if (index >= requests) break;
    const at = performance.now();
    try {
      const response = await fetch(new URL(path, origin), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      await response.arrayBuffer();
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    } catch (error) { statuses.set('network-error', (statuses.get('network-error') ?? 0) + 1); }
    durations.push(performance.now() - at);
  }
}));
durations.sort((a, b) => a - b);
const elapsedMs = performance.now() - started;
const percentile = p => Math.round(durations[Math.min(durations.length - 1, Math.ceil(p * durations.length) - 1)] ?? 0);
console.log(JSON.stringify({ target: `${origin.origin}${path}`, requests, concurrency, elapsedMs: Math.round(elapsedMs), requestsPerSecond: Number((requests * 1000 / elapsedMs).toFixed(2)), p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), statuses: Object.fromEntries(statuses) }, null, 2));
if (statuses.size !== 1 || !statuses.has(200)) process.exitCode = 1;
