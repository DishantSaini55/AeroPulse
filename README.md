# AeroPulse

AeroPulse is an independent airport infrastructure monitoring simulation inspired by concepts observed during an Airports Authority of India CNS internship. It is a portfolio software project and has no connection to operational airport systems or confidential data.

## Implementation status

The current implementation is a TypeScript Express API with a PostgreSQL/Prisma asset registry for ten logical systems and twenty simulated devices. A dedicated simulator writes equipment-specific telemetry and heartbeats every five seconds. A separate backend service retrieves real VIDP METAR observations from the public Aviation Weather Center API, caches them for five minutes and persists them. Weather responses expose stale and unavailable states. Input validation, JSON error responses and HTTP tests are included. The operations-note example remains in memory. Authentication, real-time delivery and the web interface are planned work; they are not yet implemented.

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/v1/health` | API availability |
| GET | `/api/v1/systems` | List systems with primary and secondary devices |
| GET | `/api/v1/systems/:code` | Retrieve one logical system |
| GET | `/api/v1/devices/:code/telemetry` | Paginated telemetry history and latest heartbeat |
| GET | `/api/v1/weather/vidp` | Real VIDP METAR observation with cache and freshness state |
| GET | `/api/v1/notes` | List simulated operations notes |
| GET | `/api/v1/notes/:id` | Retrieve one note |
| POST | `/api/v1/notes` | Create a note |

`POST /api/v1/notes` accepts `systemName` and `message` as non-empty strings. Notes are temporary and are cleared when the API process stops. They are not equipment telemetry or operational records.

Telemetry history accepts `page` (default `1`) and `limit` (default `20`, maximum `100`). The simulator's default scenario is normal operation; its internal generator also supports gradual degradation, failure and recovery for future administrator-controlled simulation. The simulator currently runs in one API process. Multi-instance coordination and telemetry retention are planned for later infrastructure work.

The weather response is labelled `simulated: false` and includes observation and fetch timestamps, temperature (°C), dew point (°C), visibility (statute miles), wind speed (knots), wind direction (degrees), pressure (hPa), conditions and raw METAR when available. A cached observation may be returned with `stale: true` after an upstream error; without an observation the endpoint returns `503`. The Aviation Weather Center is an external source and may be unavailable.

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
Invoke-RestMethod -Uri 'http://localhost:4000/api/v1/devices/RADAR-P/telemetry?limit=5'
Invoke-RestMethod -Uri 'http://localhost:4000/api/v1/weather/vidp'
```

## Architecture

The current API lives in `apps/api`. `apps/web`, `packages/shared` and `infra` reserve space for later components. Planned technologies will be introduced as the related features are implemented.

All future equipment readings will be labelled simulated. Public aviation weather observations, when integrated, will be labelled as external data. AeroPulse is not suitable for operational monitoring or aviation decisions.
