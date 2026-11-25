# AeroPulse

AeroPulse is an independent airport infrastructure monitoring simulation inspired by concepts observed during an Airports Authority of India CNS internship. It is a portfolio software project and has no connection to operational airport systems or confidential data.

## Implementation status

The current implementation includes a TypeScript Express API, PostgreSQL/Prisma asset registry for ten logical systems and twenty simulated devices, five-second simulated telemetry, and cached real VIDP METAR observations. A React operations console provides an overview, infrastructure table, device history charts, aviation weather view and live telemetry event console. Socket.IO broadcasts telemetry batches after database commit; the browser refreshes current state through REST on events and reconnects. HTTP polling remains available during disconnection. The operations-note example remains in memory. Authentication and role-based access are planned work.

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

In a second terminal, start the frontend:

```powershell
cd apps/web
npm.cmd ci
npm.cmd run dev
```

Open `http://127.0.0.1:5173/`. Vite proxies `/api` and `/socket.io` to the backend on port 4000. The current working pages are Overview, Infrastructure, Device Details and Aviation Weather. The desktop-first console supports light/dark themes, search and filters, and a collapsible sidebar. Live telemetry events invalidate the relevant REST queries; when the stream is unavailable the frontend polls every five seconds. Socket.IO events are transient, so reconnect re-fetches the durable current state from the API.

With both servers running, `npm.cmd run check:realtime` from `apps/web` verifies that a telemetry batch reaches a client through the Vite websocket proxy.

On systems where the `npm` PowerShell shim works, `npm` can replace `npm.cmd`. The API listens on port 4000 by default; set `PORT` to use another port.

Example request:

```powershell
Invoke-RestMethod -Uri http://localhost:4000/api/v1/notes -Method Post -ContentType application/json -Body '{"systemName":"Radar System","message":"Training observation"}'
Invoke-RestMethod -Uri 'http://localhost:4000/api/v1/devices/RADAR-P/telemetry?limit=5'
Invoke-RestMethod -Uri 'http://localhost:4000/api/v1/weather/vidp'
```

## Architecture

The API lives in `apps/api`, and the React console in `apps/web`. `packages/shared` and `infra` reserve space for later components. Planned technologies will be introduced as the related features are implemented.

All future equipment readings will be labelled simulated. Public aviation weather observations, when integrated, will be labelled as external data. AeroPulse is not suitable for operational monitoring or aviation decisions.
