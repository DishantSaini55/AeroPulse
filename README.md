# AeroPulse

**AeroPulse** is an independent, portfolio-focused simulation of an airport Communication, Navigation and Surveillance (CNS) operations platform. It models equipment health, active-standby redundancy, faults, diagnosis, incidents, maintenance and reliability analytics.

It is inspired by operational concepts observed during an Airports Authority of India internship. It **does not connect to airport infrastructure, use confidential data, or represent a production airport system**. All equipment data is explicitly simulated. Aviation weather observations will be fetched separately from the public Aviation Weather Center METAR API.

## Current status

Phase 1 — project architecture and environment planning — is complete. Application code and dependencies intentionally have not been added yet.

## Planned technology stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Web application | React, TypeScript, Vite, Tailwind CSS | Operations interface |
| API | Node.js, Express, TypeScript | REST API and domain services |
| Real-time delivery | Socket.IO | Live telemetry, alarms and failover updates |
| Data | PostgreSQL, Prisma | Reliable relational storage and migrations |
| Validation and security | Zod, JWT, bcrypt | Trusted inputs, authentication and role-based access |
| Async processing | Redis and BullMQ | Scheduled weather retrieval and background retention work |
| Deployment | Docker, Nginx, GitHub Actions | Reproducible delivery and later resilience demonstration |

## Architecture and roadmap

See [the architecture plan](docs/architecture.md) for the system boundaries, data design, security model and reliability decisions. See [the development roadmap](docs/development-roadmap.md) for the gated milestone plan.

## Repository layout

```text
apps/
  api/             # Future Express API and simulator
  web/             # Future React operations console
packages/
  shared/          # Future shared API/event contracts
docs/              # Architecture and learning documentation
infra/             # Future Docker, Nginx and CI configuration
```

## Prerequisites (before Phase 2)

- Node.js 22 LTS or later (available in the current development environment)
- npm (available as `npm.cmd`; PowerShell currently blocks `npm.ps1`)
- Docker Desktop (available; its user config needs permission repair before containers are used)
- PostgreSQL 16+ for local database work, or Docker Desktop once its configuration is accessible

No credentials, secrets or airport-system details belong in this repository. A future `.env.example` will contain names and safe placeholders only.

## Planned roles

- **Administrator** — system configuration, users, equipment, and simulation controls.
- **Supervisor** — operational oversight, incident assignment, failback and replacement approvals.
- **Maintenance Engineer** — alarm acknowledgement, investigation and repair records.

## Safety and scope

This project is a training simulation. Never rely on it for operational safety, aviation decisions, maintenance instructions, or real infrastructure monitoring.
