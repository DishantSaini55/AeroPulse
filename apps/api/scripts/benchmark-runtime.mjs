// Bounded, local-only AeroPulse runtime benchmark. Uses the isolated test database and read-only workloads.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as createClient } from 'socket.io-client';
import { SignJWT } from 'jose';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';
import { buildReportDocument } from '../dist/reports/document-data.js';
import { renderReportPdf } from '../dist/reports/pdf.js';
import { NotificationService } from '../dist/notifications/service.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const apiRoot = resolve(here, '..');
const databaseUrl = process.env.BENCH_DATABASE_URL ?? 'postgresql://aeropulse_test:aeropulse_test@127.0.0.1:55432/aeropulse_test?schema=public';
const database = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.pathname !== '/aeropulse_test' || database.port !== '55432') {
  throw new Error('Refusing to benchmark: BENCH_DATABASE_URL must target the isolated loopback aeropulse_test database on port 55432');
}
const apiPort = Number(process.env.BENCH_PORT ?? 4127);
const count = Number(process.env.BENCH_REQUESTS ?? 120);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 6);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535 || !Number.isInteger(count) || count < 20 || count > 500 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
  throw new Error('BENCH_PORT, BENCH_REQUESTS (20..500), or BENCH_CONCURRENCY (1..12) is out of bounds');
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const reportPath = resolve(apiRoot, '../../docs/performance-benchmark-2026-11-27.json');
let previousOutput;
try { previousOutput = JSON.parse(await readFile(reportPath, 'utf8')); } catch { /* first run establishes the baseline */ }
let api;
let apiLogs = '';
const apiSecret = randomBytes(48).toString('base64url');
const socketPort = apiPort === 65535 ? 4128 : apiPort + 1;

function summarize(samples, elapsedMs, statuses) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => Number((sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0).toFixed(2));
  const total = Object.values(statuses).reduce((sum, value) => sum + value, 0);
  const failed = Object.entries(statuses).filter(([code]) => code !== '200').reduce((sum, [, value]) => sum + value, 0);
  return { requests: samples.length, elapsedMs: Number(elapsedMs.toFixed(2)), requestsPerSecond: Number((samples.length * 1000 / elapsedMs).toFixed(2)), p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), errorRatePct: Number((failed * 100 / Math.max(1, total)).toFixed(2)), statuses };
}

async function waitForApi(base, token) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error(`API exited early (${api.exitCode}): ${apiLogs}`);
    try {
      const response = await fetch(`${base}/api/v1/ready`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* startup retry */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for local API readiness: ${apiLogs}`);
}

async function benchmarkHttp(base, token, path, requests, workers) {
  const samples = [], statuses = {};
  let responseBytes = 0;
  let next = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: workers }, async () => {
    while (true) {
      const index = next++;
      if (index >= requests) return;
      const at = performance.now();
      let status = 'network-error';
      try {
        const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        responseBytes += (await response.arrayBuffer()).byteLength;
        status = String(response.status);
      } catch { /* count the failed request below */ }
      statuses[status] = (statuses[status] ?? 0) + 1;
      samples.push(performance.now() - at);
    }
  }));
  return { ...summarize(samples, performance.now() - start, statuses), totalResponseBytes: responseBytes, averageResponseBytes: Math.round(responseBytes / samples.length) };
}

async function benchmarkSocket() {
  const http = createServer();
  const io = new Server(http, { cors: { origin: false }, transports: ['websocket'] });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(socketPort, '127.0.0.1', resolve); });
  const samples = [];
  try {
    const client = createClient(`http://127.0.0.1:${socketPort}`, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); setTimeout(() => reject(new Error('Socket.IO probe connect timeout')), 5000).unref(); });
    for (let i = 0; i < 60; i++) {
      const startedAt = performance.now();
      const sample = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket.IO propagation timeout')), 2000);
        client.once('bench:propagation', () => { clearTimeout(timer); resolve(performance.now() - startedAt); });
      });
      io.emit('bench:propagation', { sequence: i });
      samples.push(await sample);
    }
    client.close();
  } finally {
    await new Promise(resolve => io.close(resolve));
  }
  return summarize(samples, samples.reduce((sum, value) => sum + value, 0), { '200': samples.length });
}

async function measurePdf(actor) {
  const samples = [], byteSizes = [];
  const to = new Date().toISOString().slice(0, 10);
  const from = to;
  for (let i = 0; i < 5; i++) {
    const at = performance.now();
    const report = await buildReportDocument(db, { type: 'health', from, to, device: 'RADAR-P', format: 'pdf' }, actor);
    const bytes = await renderReportPdf(report);
    samples.push(performance.now() - at);
    byteSizes.push(bytes.byteLength);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF benchmark returned an invalid document');
  }
  return { ...summarize(samples, samples.reduce((sum, value) => sum + value, 0), { '200': samples.length }), pdfBytes: byteSizes };
}

async function measureNotificationDispatch(userId) {
  class RollbackBenchmarkFixture extends Error {}
  const samples = [], processed = [];
  for (let run = 0; run < 3; run++) {
    const startedAt = performance.now();
    try {
      await db.$transaction(async tx => {
        const event = await tx.notificationEvent.create({ data: {
          sourceKey: `benchmark:${randomUUID()}`, kind: 'ALARM_RAISED', priority: 'INFORMATION',
          title: 'Local benchmark fixture', body: 'Transaction rolls this benchmark row back.',
        }, select: { id: true } });
        const recipient = await tx.notificationRecipient.create({ data: { eventId: event.id, userId }, select: { id: true } });
        await tx.notificationDelivery.create({ data: { recipientId: recipient.id, channel: 'IN_APP', status: 'PENDING', nextAttemptAt: new Date(Date.now() - 1000) } });
        processed.push(await new NotificationService(tx).dispatchDue(100, () => {}));
        throw new RollbackBenchmarkFixture();
      }, { maxWait: 5000, timeout: 20_000 });
    } catch (error) {
      if (!(error instanceof RollbackBenchmarkFixture)) throw error;
    }
    samples.push(performance.now() - startedAt);
  }
  return { ...summarize(samples, samples.reduce((sum, value) => sum + value, 0), { '200': samples.length }),
    deliveriesDispatchedInRolledBackTransactions: processed, averageDeliveriesPerSecond: Number((processed.reduce((sum, value) => sum + value, 0) * 1000 / samples.reduce((sum, value) => sum + value, 0)).toFixed(2)),
    persistentWrites: 0 };
}

async function measureBundle() {
  const assets = resolve(apiRoot, '../web/dist/assets');
  const files = await readdir(assets);
  const rows = await Promise.all(files.filter(name => /\.(js|css)$/.test(name)).map(async name => {
    const path = resolve(assets, name), content = await readFile(path);
    return { name, bytes: (await stat(path)).size, gzipBytes: gzipSync(content).byteLength };
  }));
  return { files: rows, totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0), totalGzipBytes: rows.reduce((sum, row) => sum + row.gzipBytes, 0) };
}

try {
  const user = await db.user.findFirst({ where: { active: true, role: { in: ['SUPERVISOR', 'ADMINISTRATOR'] } }, select: { id: true, email: true, name: true, role: true, active: true } });
  if (!user) throw new Error('Isolated test database has no active supervisor/admin user; refusing to seed or mutate it');
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setIssuer('aeropulse').setAudience('aeropulse-web').setExpirationTime('10m').sign(new TextEncoder().encode(apiSecret));
  const base = `http://127.0.0.1:${apiPort}`;
  api = spawn(process.execPath, ['--require', resolve(here, 'benchmark-process-preload.cjs'), 'dist/server.js'], { cwd: apiRoot, env: { ...process.env, DATABASE_URL: databaseUrl, JWT_SECRET: apiSecret, PORT: String(apiPort), NODE_ENV: 'test', DISABLE_BACKGROUND_JOBS: '1', REDIS_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', chunk => { apiLogs += chunk.toString(); });
  api.stderr.on('data', chunk => { apiLogs += chunk.toString(); });
  await waitForApi(base, token);
  const apiResults = {};
  for (const [name, path] of Object.entries({ notificationInbox: '/api/v1/notifications?limit=20', monitoringSnapshot: '/api/v1/monitoring/snapshot', alarms: '/api/v1/alarms?limit=20' })) {
    apiResults[name] = await benchmarkHttp(base, token, path, count, concurrency);
  }
  const processSamples = apiLogs.split(/\r?\n/).filter(line => line.startsWith('BENCH_PROCESS_METRIC ')).map(line => { try { return JSON.parse(line.slice('BENCH_PROCESS_METRIC '.length)); } catch { return undefined; } }).filter(Boolean);
  const processUsage = processSamples.length ? {
    samples: processSamples.length,
    cpuSeconds: Number(((processSamples.at(-1).cpuMicros - processSamples[0].cpuMicros) / 1_000_000).toFixed(4)),
    peakRssBytes: Math.max(...processSamples.map(sample => sample.rssBytes)),
    endingRssBytes: processSamples.at(-1).rssBytes,
  } : { unavailable: 'No API process metrics received from the local preload sampler' };
  const socket = await benchmarkSocket();
  const pdf = await measurePdf(user);
  const notificationDispatch = await measureNotificationDispatch(user.id);
  const rawQueryPlan = await db.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT "id", "eventId", "readAt", "createdAt" FROM "NotificationRecipient" WHERE "userId" = ${user.id}::uuid ORDER BY "createdAt" DESC LIMIT 20`;
  const queryPlan = JSON.parse(JSON.stringify(rawQueryPlan).replaceAll(user.id, '[local benchmark user]'));
  const output = {
    generatedAt: new Date().toISOString(), target: 'loopback only; isolated aeropulse_test PostgreSQL; background jobs disabled',
    configuration: { requestsPerApiPath: count, concurrency, socketSamples: 60, pdfSamples: 5 },
    api: apiResults, socketPropagation: socket, reportPdf: pdf, notificationDispatch, notificationRecipientQueryPlan: queryPlan,
    apiProcessUsage: processUsage, frontendBundle: await measureBundle(),
  };
  if (previousOutput) output.previousRunReference = {
    generatedAt: previousOutput.generatedAt,
    api: previousOutput.api,
    comparisonWithPreviousRun: previousOutput.comparisonWithPreviousRun ?? previousOutput.previousRunReference?.comparisonWithPreviousRun ?? null,
  };
  if (previousOutput?.api && previousOutput?.frontendBundle) {
    const pct = (before, after) => before ? Number(((after - before) * 100 / before).toFixed(2)) : null;
    output.comparisonWithPreviousRun = {
      sameConfiguration: JSON.stringify(previousOutput.configuration) === JSON.stringify(output.configuration),
      api: Object.fromEntries(Object.keys(apiResults).map(name => [name, {
        p50ChangePct: pct(previousOutput.api[name]?.p50Ms, apiResults[name].p50Ms),
        p95ChangePct: pct(previousOutput.api[name]?.p95Ms, apiResults[name].p95Ms),
        p99ChangePct: pct(previousOutput.api[name]?.p99Ms, apiResults[name].p99Ms),
        throughputChangePct: pct(previousOutput.api[name]?.requestsPerSecond, apiResults[name].requestsPerSecond),
        responseBytesChangePct: pct(previousOutput.api[name]?.averageResponseBytes, apiResults[name].averageResponseBytes),
      }])),
      frontendBundleBytesChangePct: pct(previousOutput.frontendBundle.totalBytes, output.frontendBundle.totalBytes),
      frontendBundleGzipBytesChangePct: pct(previousOutput.frontendBundle.totalGzipBytes, output.frontendBundle.totalGzipBytes),
    };
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'w' });
  console.log(JSON.stringify({ ...output, reportPath }, null, 2));
  if (Object.values(apiResults).some(result => result.errorRatePct !== 0)) process.exitCode = 1;
} finally {
  if (api && api.exitCode === null) {
    api.kill('SIGTERM');
    await Promise.race([new Promise(resolve => api.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 7000))]);
  }
  await db.$disconnect();
}
