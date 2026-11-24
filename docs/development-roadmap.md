# Development roadmap

Each phase is a deliberate checkpoint. Do not start the next one until the previous phase works, is reviewed, and is committed by the repository owner.

## Phase 1 — completed: environment and architecture

- Inspected the local workspace and supplied remote.
- Created repository foundation, directory layout, README, `.gitignore` and architecture documents.
- Recorded local prerequisites and environment limitations.
- No application runtime code, dependencies, containers or database schema were introduced.

## Phase 2 — Express fundamentals

Create the TypeScript Express API, health route, error handler, Zod validation pattern and initial REST resource. Learn HTTP request/response, status codes, middleware and JSON.

## Phase 3 — PostgreSQL and Prisma

Install PostgreSQL access, model the asset registry first, add migrations and seed the ten systems with twenty simulated devices. Learn tables, foreign keys, migrations, indexes and transactions.

## Phase 4 — simulator

Implement deterministic, correlated five-second telemetry and heartbeats; persist readings and create testable normal/degraded/failure/recovery scenarios.

## Phase 5 — aviation weather

Add a timeout-protected and cached server-side METAR client, weather persistence, stale-data indicator and tests.

## Phases 6–18 — build in vertical slices

Proceed only after explicit approval: frontend design system, live Socket.IO delivery, identity and roles, redundancy/failover, diagnostic rules, alarm experience, incident and maintenance workflows, analytics, recommendation engine, reporting/auditing, Docker/Redis/Nginx resilience, then security/testing/deployment documentation.

## Phase 19 — interview preparation

Review trade-offs, demonstrate each flow, practise troubleshooting questions and distinguish implemented facts from planned enhancements.

## Phase 1 environment findings

| Item | Result | Implication |
| --- | --- | --- |
| Workspace | Initially empty | A new local repository was initialized. |
| GitHub remote | Reachable but no branch refs | The remote appears to have no initial commit. |
| Node.js | `v22.20.0` | Suitable for the planned TypeScript work. |
| npm/npx | Installed as `.cmd` executables | Use `npm.cmd` / `npx.cmd` unless PowerShell execution policy changes. |
| Docker | Installed | Docker client warns it cannot read the user Docker config; resolve before container work. |
| PostgreSQL client | Not found on `PATH` | Install PostgreSQL or use Docker in Phase 3. |
| Git ownership | Sandbox user differs from folder owner | Use a one-command `-c safe.directory=D:/AAI` override, or resolve ownership yourself. Do not silently change global Git config. |

## Suggested next milestone

After review, Phase 2 should establish a minimal API without authentication, database or production infrastructure. This lets you learn the request lifecycle before adding complexity.
