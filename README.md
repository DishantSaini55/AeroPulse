# AeroPulse

AeroPulse is an independent airport infrastructure monitoring simulation inspired by concepts observed during an Airports Authority of India CNS internship. It is a portfolio software project and has no connection to operational airport systems or confidential data.

## Implementation status

The current implementation is a TypeScript Express API with a PostgreSQL/Prisma asset registry for ten logical systems and twenty simulated devices. Input validation, JSON error responses and HTTP tests are included. The operations-note example remains in memory. Equipment telemetry, authentication, real-time delivery and the web interface are planned work; they are not yet implemented.

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/v1/health` | API availability |
| GET | `/api/v1/systems` | List systems with primary and secondary devices |
| GET | `/api/v1/systems/:code` | Retrieve one logical system |
| GET | `/api/v1/notes` | List simulated operations notes |
| GET | `/api/v1/notes/:id` | Retrieve one note |
| POST | `/api/v1/notes` | Create a note |

`POST /api/v1/notes` accepts `systemName` and `message` as non-empty strings. Notes are temporary and are cleared when the API process stops. They are not equipment telemetry or operational records.

## Local development

Requires Node.js 22 or later, npm and PostgreSQL 16 or later. Copy `apps/api/.env.example` to `apps/api/.env` and set a local `DATABASE_URL`. From the repository root:

```powershell
cd apps/api
npm.cmd ci
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd test
npm.cmd run dev
```

On systems where the `npm` PowerShell shim works, `npm` can replace `npm.cmd`. The API listens on port 4000 by default; set `PORT` to use another port.

Example request:

```powershell
Invoke-RestMethod -Uri http://localhost:4000/api/v1/notes -Method Post -ContentType application/json -Body '{"systemName":"Radar System","message":"Training observation"}'
```

## Architecture

The current API lives in `apps/api`. `apps/web`, `packages/shared` and `infra` reserve space for later components. Planned technologies will be introduced as the related features are implemented.

All future equipment readings will be labelled simulated. Public aviation weather observations, when integrated, will be labelled as external data. AeroPulse is not suitable for operational monitoring or aviation decisions.
