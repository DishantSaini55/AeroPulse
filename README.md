# AeroPulse

AeroPulse is an independent airport infrastructure monitoring simulation inspired by concepts observed during an Airports Authority of India CNS internship. It is a portfolio software project and has no connection to operational airport systems or confidential data.

## Implementation status

The current implementation includes a TypeScript Express API, PostgreSQL/Prisma asset registry for ten logical systems and twenty simulated devices, five-second simulated telemetry, heartbeat monitoring, and cached real VIDP METAR observations. A React operations console provides an overview, infrastructure table, redundancy view, device history charts, aviation weather view and live telemetry event console. Socket.IO broadcasts telemetry batches after database commit and status changes; the browser refreshes current state through REST on events and reconnects. HTTP polling remains available during disconnection. JWT login protects the API and live stream. Administrators can manage users and create temporary operations notes; supervisors and maintenance engineers have read access.

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/v1/health` | API availability |
| POST | `/api/v1/auth/login` | Sign in and receive an eight-hour JWT |
| GET | `/api/v1/auth/me` | Current account |
| GET, POST | `/api/v1/users` | List and create accounts (administrator) |
| PATCH | `/api/v1/users/:id` | Change account role, name or active state (administrator) |
| GET | `/api/v1/systems` | List systems with primary and secondary devices |
| GET | `/api/v1/systems/:code` | Retrieve one logical system |
| GET | `/api/v1/redundancy` | Active assignments, standby readiness, heartbeat policy and service state |
| GET | `/api/v1/devices/:code/telemetry` | Paginated telemetry history and latest heartbeat |
| GET | `/api/v1/weather/vidp` | Real VIDP METAR observation with cache and freshness state |
| GET | `/api/v1/notes` | List simulated operations notes |
| GET | `/api/v1/notes/:id` | Retrieve one note |
| POST | `/api/v1/notes` | Create a note |

All endpoints except health and login require `Authorization: Bearer <token>`. The Socket.IO handshake also requires the token in `auth.token`. `POST /api/v1/notes` is administrator-only and accepts `systemName` and `message` as non-empty strings. Notes are temporary and are cleared when the API process stops. They are not equipment telemetry or operational records.

Telemetry history accepts `page` (default `1`) and `limit` (default `20`, maximum `100`). The simulator's default scenario is normal operation; its internal generator also supports gradual degradation, failure and recovery for future administrator-controlled simulation. The simulator currently runs in one API process. Multi-instance coordination and telemetry retention are planned for later infrastructure work.

The heartbeat monitor checks every five seconds. By default, a device becomes unavailable after three missed expected five-second heartbeats; set `HEARTBEAT_MISSED_LIMIT` (1–12) to change the threshold. Its state returns to healthy when a fresh heartbeat arrives. Logical service availability follows the active device. A healthy standby is shown as ready but is not activated automatically yet; automatic failover and manual failback belong to the next phase.

The weather response is labelled `simulated: false` and includes observation and fetch timestamps, temperature (°C), dew point (°C), visibility (statute miles), wind speed (knots), wind direction (degrees), pressure (hPa), conditions and raw METAR when available. A cached observation may be returned with `stale: true` after an upstream error; without an observation the endpoint returns `503`. The Aviation Weather Center is an external source and may be unavailable.

## Local development

Requires Node.js 22 or later, npm and PostgreSQL 16 or later. Copy `apps/api/.env.example` to ignored `apps/api/.env` and set a local `DATABASE_URL` and a unique random `JWT_SECRET` of at least 32 bytes. Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` there temporarily; the password must be 12–72 UTF-8 bytes. From the repository root:

```powershell
cd apps/api
npm.cmd ci
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run auth:bootstrap
npm.cmd test
npm.cmd run dev
```

Remove `BOOTSTRAP_ADMIN_PASSWORD` from `.env` after creating the first administrator. Bootstrap refuses to run if an administrator already exists. Subsequent accounts are created in the User management page. Never commit `.env` or share account passwords in issues or screenshots.

In a second terminal, start the frontend:

```powershell
cd apps/web
npm.cmd ci
npm.cmd run dev
```

Open `http://127.0.0.1:5173/` and sign in. Vite proxies `/api` and `/socket.io` to the backend on port 4000. The Redundancy page shows per-device heartbeat recency, active assignment and standby readiness. Administrators also see User management. The desktop-first console supports light/dark themes, search and filters, and a collapsible sidebar. Live telemetry and status events invalidate the relevant REST queries; when the stream is unavailable the frontend polls every five seconds. Socket.IO events are transient, so reconnect re-fetches the durable current state from the API. The browser keeps the JWT in session storage, which clears when its tab session ends.

With both servers running, set `REALTIME_TOKEN` to a valid token from `POST /api/v1/auth/login`, then run `npm.cmd run check:realtime` from `apps/web` to verify a telemetry batch through the Vite websocket proxy.

On systems where the `npm` PowerShell shim works, `npm` can replace `npm.cmd`. The API listens on port 4000 by default; set `PORT` to use another port.

Example request:

```powershell
$session = Invoke-RestMethod -Uri http://localhost:4000/api/v1/auth/login -Method Post -ContentType application/json -Body (@{email='admin@example.com';password='your-local-password'} | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($session.token)" }
Invoke-RestMethod -Uri 'http://localhost:4000/api/v1/devices/RADAR-P/telemetry?limit=5' -Headers $headers
Invoke-RestMethod -Uri 'http://localhost:4000/api/v1/weather/vidp' -Headers $headers
```

## Architecture

The API lives in `apps/api`, and the React console in `apps/web`. `packages/shared` and `infra` reserve space for later components. Planned technologies will be introduced as the related features are implemented.

Equipment readings are labelled simulated. Public aviation weather observations are labelled as external data. AeroPulse is not suitable for operational monitoring or aviation decisions.
Operational timestamps in the console are displayed in UTC, independent of the browser's local timezone.
