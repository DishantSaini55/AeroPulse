# AeroPulse final engineering report

Updated 2026-11-27. AeroPulse is an independent simulation inspired by infrastructure-monitoring concepts. It is not connected to Airports Authority of India systems, operational airport equipment, confidential records or aviation decision-making.

## Final milestone status

| Milestone | Status | Evidence basis |
|---|---|---|
| Prompt 4E integration | Complete | Preserved progress checkpoint records 79/79 backend tests, audio, browser, database and dual-backend Redis validation. |
| Prompt 6 persistent notifications | Complete | Preserved checkpoint records durable inbox/API, transactional event hooks, browser flow, two-backend Redis interruption/recovery and loopback-only Email/Web Push collector tests. Not repeated because this batch did not change notification behavior. |
| Prompt 7 frontend testing and CI | Complete | Previous checkpoint; current regression rerun includes web lint, unit and Playwright. |
| Prompt 8 security hardening | Complete within documented local scope | Previous checkpoint records authorization/security changes and zero known dependency vulnerabilities after the narrow `effect` override. Current 94-case suite rerun; dependency versions were not changed in this batch. |
| Prompt 9 frontend polish | Complete | Prior 30 desktop/mobile page screenshots and visual review; refreshed screenshots resulted from the current Playwright run. |
| Prompt 10 performance | Complete | Reused recorded local benchmark; no repeat benchmark was run. |
| Prompt 11 deployment/documentation | Complete for local non-public scope | Hardened Compose, editable architecture/API/operations docs, README and actual isolated production-mode stack verification. |
| Prompt 12 interview preparation | Complete | Project source map, introductions, demo, resume and study notes plus 200 numbered bilingual Q&A. |

## Delivered work

- Production Compose no longer embeds default database credentials. It requires separate URL-safe database, Redis and JWT secrets, authenticates Redis, separates migration from optional demo seeding, allows a local verification-only background-job disable, and binds the configurable web port to loopback.
- Added `apps/api/scripts/verify-deployment-runtime.mjs` and `npm run verify:deployment:local`. It permits only a plain HTTP loopback origin, requires explicit local test-account credentials, and checks readiness, Redis health, auth, key API reads, PDF generation, frontend delivery and authenticated Socket.IO.
- Updated README startup/security guidance and added editable Mermaid architecture diagrams, endpoint/authorization/API contract reference, deployment/recovery/troubleshooting/demo guide, deployment readiness record and full interview-preparation pack.
- The E2E suite rewrote 18 tracked screenshots. The refreshed desktop and mobile overview images were opened and checked; they clearly show the local disconnected/error state. The checkpoint records the earlier visual inspection of all 30 page/viewports. Screenshots depict simulated UI only.

## Implemented feature inventory

- **Monitoring:** ten logical simulated systems/twenty devices; telemetry generator, heartbeat monitoring, history, configurable rule-based diagnostics and current monitoring snapshot.
- **Redundancy:** active/standby readiness, automatic failover, manual authorized failback, row-level transaction locking, database uniqueness invariant and durable attempt history.
- **Alarm and response:** deduplicated durable alarms, per-user acknowledgement, escalation, browser alarm tone/voice controls, incident lifecycle, assignment, comments, repair records, urgent closure approval and audit history.
- **Maintenance:** recurring plans, generated/manual work orders, readiness previews, planned switches, assignment, checklists, guarded start/verification/approval, parts and Decimal costs, replacement records, analytics and maintenance announcements.
- **Reliability and reporting:** UTC reliability/telemetry analytics with recorded vs illustrative datasets, evidence-bound recommendations and review decisions, legacy exports, ten bounded A4 PDF document types and local browser preview/download.
- **Persistent notifications:** transactionally created domain events, per-user inbox/read state/preferences, bounded durable outbox attempts/retry, Socket.IO invalidation, REST reconciliation and local-only Email/Web Push capture adapters.
- **Identity/platform:** bcrypt passwords, one-hour JWT validation, administrator/supervisor/maintenance roles and resource assignment checks, security middleware/rate limits, Nginx/Socket.IO routing, two API service configuration, Redis adapter/lease, health checks, GitHub Actions and local regression harnesses.
- **Frontend:** React/TypeScript console for overview, assets, redundancy, diagnostics, alarms, incidents, notifications, maintenance, analytics, recommendations, reports, audit/event history, weather and simulation workflows; keyboard/responsive layouts, loading/error/empty states, audio/voice behavior and query invalidation/reconnect reconciliation.

## Final validation results

- API `npm.cmd run test:local`: **94 passed, 0 failed, 0 skipped**, exit 0; migrated/current isolated `aeropulse_test`, ran the seed helper and `test:ci` (including API build).
- Web ESLint: passed, zero warnings.
- Vitest: **4/4 passed**.
- Audio/voice suite: **7/7 passed**.
- Playwright: **3/3 passed**, including responsive page capture and inbox preference/read workflow.
- API and web production builds: passed. A separate final API build after adding the deployment-verifier script also passed.
- Prisma schema validation: passed; 17 migration files applied successfully in the fresh isolated production demonstration database.
- Root, test and maintenance-runtime Docker Compose configuration validation: passed. Production images built; all five services reached healthy state.
- `git diff --check`: passed. `migration_lock.toml` remains SHA256 `99836963713B4F5B269AD49AF0ED3D7B0B2E336115C2F92DC9AC683D139D0900`.

## Targeted corrections (2026-11-27)

- The monitoring snapshot now returns the configured backend heartbeat policy. Overview, infrastructure and device detail use its timeout; stale fixed 20-second and future-fault-detection copy was removed. A non-default 10-second policy is covered by the API assertion, frontend unit test and Playwright UI check.
- Redis healthcheck timing is correctly nested under `healthcheck`; its authenticated `redis-cli` probe remains. Vite uses `AEROPULSE_API_PROXY_TARGET` for both development proxies, defaulting to `http://127.0.0.1:4000`; `apps/web/.env.example` documents it. Production Nginx routing was not changed.
- Historical demo analytics remain separately selected and labelled `ILLUSTRATIVE DEMO`; recorded metrics remain on their own path. Simulator seed data was retained.
- Changed implementation and test files: `apps/api/src/app.ts`, `apps/api/src/app.test.ts`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/heartbeatFreshness.ts`, `apps/web/src/heartbeatFreshness.test.ts`, `apps/web/tests/e2e/notification-inbox.spec.ts`, `apps/web/vite.config.ts`, `apps/web/.env.example`, and `docker-compose.yml`.
- Validation: backend **94/94**; Vitest **4/4**; ESLint passed; audio **7/7**; Playwright **3/3** after updating its snapshot fixture and checking the 10-second label; API and web production builds passed. All three Compose configurations validated, and the resolved production Redis healthcheck reported interval `5s`, timeout `3s`, retries `20`, start period `5s`, with password authentication configured. `git diff --check` passed. No migration or database reset was run; `migration_lock.toml` is unchanged.

### Actual isolated production-mode check

Compose project `aeropulse_p11_verify_20261127` used new project-scoped named volumes, temporary local-only URL-safe secrets, loopback port 18080, and `AEROPULSE_DISABLE_BACKGROUND_JOBS=1`. The separate migration job succeeded; demo inventory and a temporary administrator were created only in this fresh database. `npm run verify:deployment:local` reported PostgreSQL ready, Redis ready, admin authenticated, 10 systems/20 devices in the monitoring snapshot, 20 maintenance option devices, notification inbox/preferences responding, ten report types, a valid 27,700-byte PDF, frontend app shell available and authenticated Socket.IO connected through Nginx. A second local API workflow created an inspection work order, assigned a temporary engineer and confirmed persisted `ASSIGNED` state; the engineer's inbox showed one unread assignment notification. Guarded start/verification was not exercised in this no-background-job runtime because it had no generated heartbeat records; the full lifecycle and its authorization/readiness rules passed the backend regression. The project’s containers were stopped with plain `docker compose stop`; volumes were retained. Existing `aai` containers were left running and untouched.

The local verifier does not run simulated background jobs, so it does not validate autonomous telemetry/retention/weather scheduling in this pass. This avoids any external weather request. Live work-order create/assign and the durable notification recipient were checked; guarded start/verification lifecycle transitions are covered by the database regression. Prompt 6’s live inbox and Redis failover evidence is reused. No real messages were sent.

## Performance evidence (reused; not rerun)

The equivalent 120-request/concurrency-6 monitoring snapshot comparison measured p95 at **2,224.34 ms before** and **136.68 ms after** the consolidated SQL/indexed lateral-read change (93.86% lower). The final recorded local sample measured **85.41 requests/s**, **63.23 ms p50**, **106.37 ms p95**, **138.68 ms p99**, and **0% observed errors**. Inbox sample: 31.29 RPS / 152.91 ms p50 / 267.86 ms p95 / 783.02 ms p99. Alarm sample: 47.70 RPS / 121.48 ms p50 / 164.33 ms p95 / 178.92 ms p99. Local Socket.IO loopback p95 was 2.42 ms, not a cross-backend fanout benchmark. PDF p95 was 1,308.40 ms across five one-device renders. Dispatcher sample was 109.51 deliveries/s across three rolled-back 100-delivery runs. Full results and methods are in `performance-benchmark-2026-11-27.md` and `.json`.

These measurements describe the local machine, test data and specific harness. They do not establish production capacity, internet latency, multi-region performance or uptime.

## Security findings and deployment limitations

- Required Compose secrets remove insecure credential defaults; Redis is password-protected; the web host bind is loopback; the API runtime uses a non-root account. Trusted proxy hops default to zero and are explicitly bounded. JWTs are one hour with issuer/audience/algorithm checks; passwords use bcrypt. Strict request validation, role/resource checks, mutation rate limits, CSP/security headers and redacted metadata logging are covered in the prior Prompt 8 record and current API suite.
- Previous release dependency audits reported zero known vulnerabilities after pinning the compatible patched `effect` dependency. No package versions changed in this final batch; a fresh audit was therefore not rerun.
- No public/paid deployment, external provider configuration, TLS ingress, managed secret service, backup service, restore rehearsal, remote CI execution or multi-zone infrastructure was created.
- Compose remains a single-host demonstration: PostgreSQL, Redis, Nginx and the host are shared failure domains. The Redis lease is not a consensus protocol or comprehensive partition fencing. Email/Web Push adapters are local capture stubs only. PDF process gates/rate state are not globally coordinated across instances.
- Runbook backup/recovery steps are documented but no backup or restore was executed. Deployment readiness requires an authorized operator to provision ingress, secret rotation, least-privilege DB access, resource limits, encryption/retention, monitoring, alert ownership and recovery drills.

## Public documentation and safe manual Git commands

The repository ignores `/docs/`. Only these reviewed public artifacts are proposed: this report; the progress checkpoint; deployment readiness, architecture, API and operations guides; the benchmark Markdown/JSON; the three interview-preparation Markdown files; and the 30 local simulation screenshots under `docs/prompt-9-browser-review/`. Do not stage logs, PDF samples, raw database exports, `.env` files, private artifacts or the entire `docs/` tree.

Review the worktree and stage the chosen files manually:

```powershell
git status --short
git add README.md docker-compose.yml apps/api/package.json apps/api/scripts/verify-deployment-runtime.mjs
git add -f docs/final-master-progress.md docs/final-engineering-report.md docs/deployment-readiness-2026-11-27.md docs/architecture.md docs/api-reference.md docs/operations-guide.md docs/performance-benchmark-2026-11-27.md docs/performance-benchmark-2026-11-27.json docs/interview-preparation/README.md docs/interview-preparation/questions-001-100.md docs/interview-preparation/questions-101-200.md
git add -f docs/prompt-9-browser-review/alarms-desktop.png docs/prompt-9-browser-review/alarms-mobile.png docs/prompt-9-browser-review/analytics-desktop.png docs/prompt-9-browser-review/analytics-mobile.png docs/prompt-9-browser-review/diagnostics-desktop.png docs/prompt-9-browser-review/diagnostics-mobile.png docs/prompt-9-browser-review/event-history-desktop.png docs/prompt-9-browser-review/event-history-mobile.png docs/prompt-9-browser-review/incidents-desktop.png docs/prompt-9-browser-review/incidents-mobile.png docs/prompt-9-browser-review/infrastructure-desktop.png docs/prompt-9-browser-review/infrastructure-mobile.png docs/prompt-9-browser-review/maintenance-desktop.png docs/prompt-9-browser-review/maintenance-mobile.png docs/prompt-9-browser-review/notifications-desktop.png docs/prompt-9-browser-review/notifications-mobile.png docs/prompt-9-browser-review/overview-desktop.png docs/prompt-9-browser-review/overview-mobile.png docs/prompt-9-browser-review/recommendations-desktop.png docs/prompt-9-browser-review/recommendations-mobile.png docs/prompt-9-browser-review/redundancy-desktop.png docs/prompt-9-browser-review/redundancy-mobile.png docs/prompt-9-browser-review/reports-desktop.png docs/prompt-9-browser-review/reports-mobile.png docs/prompt-9-browser-review/simulation-desktop.png docs/prompt-9-browser-review/simulation-mobile.png docs/prompt-9-browser-review/users-desktop.png docs/prompt-9-browser-review/users-mobile.png docs/prompt-9-browser-review/weather-desktop.png docs/prompt-9-browser-review/weather-mobile.png
git diff --cached --check
git status --short
```

Suggested commit messages:

```text
Complete Prompts 11 and 12
Harden local deployment and publish engineering docs
```

No Git staging, commit, branch, push or remote deployment was performed.
