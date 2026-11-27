# AeroPulse local performance benchmark

Measured 2026-11-27 against loopback API and the isolated `aeropulse_test` PostgreSQL database. API background jobs were disabled. Each API endpoint received 120 GET requests at concurrency 6; status errors were counted as failures. Results are machine-local and are not a production capacity claim.

## Final API measurements

| Endpoint | RPS | p50 | p95 | p99 | Errors | Mean response |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Notification inbox | 31.29 | 152.91 ms | 267.86 ms | 783.02 ms | 0/120 | 12,677 B |
| Monitoring snapshot | 85.41 | 63.23 ms | 106.37 ms | 138.68 ms | 0/120 | 13,329 B |
| Alarms | 47.70 | 121.48 ms | 164.33 ms | 178.92 ms | 0/120 | 55 B |

The monitoring snapshot originally used nested Prisma relation reads and measured 1,504.60 ms median, 2,224.34 ms p95, 2,602.69 ms p99 and 3.84 requests/s under the same 120-request/concurrency-6 setup. A single PostgreSQL statement with indexed lateral lookups for latest telemetry and heartbeat reduced those figures to 77.22 ms, 136.68 ms, 150.17 ms and 71.10 requests/s in the first post-change run (−94.87% median, −93.86% p95, −94.23% p99; +1,751.56% throughput). Subsequent runs measured 64.32–77.22 ms median, 86.95–136.68 ms p95 and 71.10–88.43 requests/s. The final endpoint returns about 13.3 KB per response.

## Other runtime measurements

- PostgreSQL inbox recipient query: `NotificationRecipient_userId_readAt_createdAt_idx` was used; `EXPLAIN (ANALYZE, BUFFERS)` execution time was 0.528 ms, with 49 shared buffer hits and no reads from disk.
- Notification dispatch: three real dispatcher runs handled 100 deliveries each at an average 109.51 deliveries/s. Each run took place inside a database transaction that was intentionally rolled back; the harness reports zero persistent writes.
- PDF generation: five direct service renders of a one-day, one-device health report; p50 644.25 ms, p95 1,308.40 ms; output sizes 20,603–20,741 bytes.
- Socket.IO loopback propagation: 60 local broadcast samples; p50 0.62 ms, p95 2.42 ms, p99 7.61 ms. This measures the local Socket.IO transport and event loop, not a distributed Redis fan-out path.
- API process during the run: 12.25 CPU seconds across 9 samples, peak RSS 201,650,176 bytes and ending RSS 157,294,592 bytes.
- Production web assets: 1,045,226 bytes raw / 300,388 bytes gzip across 7 JS/CSS files. The largest deferred chart chunk is 430,190 bytes raw / 123,193 bytes gzip.

## Reproduction and scope

From `apps/api`, run `npm.cmd run build`, then `npm.cmd run benchmark:runtime`. The script starts a loopback API with a short-lived local JWT, uses only the isolated test database, disables background jobs, enforces bounded request counts/concurrency, writes machine-readable results to [performance-benchmark-2026-11-27.json](performance-benchmark-2026-11-27.json), and stops its API child. `BENCH_REQUESTS`, `BENCH_CONCURRENCY`, and `BENCH_PORT` can tune the bounded workload. `BENCH_DATABASE_URL` is accepted only when it points to `127.0.0.1:55432/aeropulse_test`.

Frontend screenshots are in `docs/prompt-9-browser-review/`. Playwright captured 15 primary-navigation pages on desktop and at 393×852 mobile: overview, infrastructure, redundancy, diagnostics, alarms, notifications, incidents, maintenance, analytics, recommendations, reports, event history, weather, users and simulation. All 30 captures were visually inspected. The harness uses local response fixtures: it verifies layout, keyboard-reachable mobile navigation, inbox empty state, user form layout and explicit API error states; it does not claim production data coverage. Browser visual captures do not alter the test database.
