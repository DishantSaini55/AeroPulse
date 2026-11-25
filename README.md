# AeroPulse

AeroPulse is an independent airport infrastructure monitoring simulation inspired by concepts observed during an Airports Authority of India CNS internship. It is a portfolio software project and has no connection to operational airport systems or confidential data.

## Implementation status

The current implementation includes a TypeScript Express API, PostgreSQL/Prisma asset registry for ten logical systems and twenty simulated devices, five-second simulated telemetry, heartbeat monitoring, automatic active-standby failover, authorized manual failback, durable failover history, rule-based fault diagnostics, and cached real VIDP METAR observations. A React operations console provides overview, infrastructure, redundancy, fault diagnostics, simulation laboratory, device history, aviation weather and live telemetry views. Socket.IO broadcasts telemetry batches after database commit and status changes; the browser refreshes current state through REST on events and reconnects. HTTP polling remains available during disconnection. JWT login protects the API and live stream. Administrators manage users and simulation scenarios; supervisors can perform failback; engineers can record confirmed root causes.

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
| GET | `/api/v1/failover-events` | Recent durable failover/failback attempts, up to 100 |
| POST | `/api/v1/systems/:code/failback` | Restore a recovered primary (administrator or supervisor) |
| POST | `/api/v1/simulation/devices/:code/heartbeat` | Pause or resume a simulated heartbeat (administrator) |
| GET | `/api/v1/diagnoses` | Suspected faults, evidence, history and configurable thresholds |
| PATCH | `/api/v1/diagnoses/:id/confirm` | Record a verified root cause |
| GET | `/api/v1/simulation/devices` | List current local simulation scenarios (administrator) |
| POST | `/api/v1/simulation/devices/:code/scenario` | Inject a device scenario (administrator) |
| POST | `/api/v1/simulation/systems/:code/scenario` | Inject a correlated system scenario (administrator) |
| GET | `/api/v1/devices/:code/telemetry` | Paginated telemetry history and latest heartbeat |
| GET | `/api/v1/weather/vidp` | Real VIDP METAR observation with cache and freshness state |
| GET | `/api/v1/notes` | List simulated operations notes |
| GET | `/api/v1/notes/:id` | Retrieve one note |
| POST | `/api/v1/notes` | Create a note |

All endpoints except health and login require `Authorization: Bearer <token>`. The Socket.IO handshake also requires the token in `auth.token`. `POST /api/v1/notes` is administrator-only and accepts `systemName` and `message` as non-empty strings. Notes are temporary and are cleared when the API process stops. They are not equipment telemetry or operational records.

Telemetry history accepts `page` (default `1`) and `limit` (default `20`, maximum `100`). The simulator's default scenario is normal operation; its internal generator also supports gradual degradation, failure and recovery for future administrator-controlled simulation. The simulator currently runs in one API process. Multi-instance coordination and telemetry retention are planned for later infrastructure work.

The redundancy manager checks every five seconds. By default, a device becomes unavailable after three missed expected five-second heartbeats; set `HEARTBEAT_MISSED_LIMIT` (1–12) to change the threshold. On active-device failure it activates a healthy standby in a database transaction. If neither device is healthy, service availability becomes `OUTAGE`. A recovered primary remains inactive until an administrator or supervisor requests failback. Each attempt records its result and duration. The database locks each system row during assignment changes and enforces at most one active device per system with a partial unique index.

The diagnostic engine evaluates persisted simulated telemetry and heartbeat recency. Rules cover thermal stress, cooling fan symptoms, resource overload, memory pressure, storage pressure, network degradation, low voltage, missing heartbeat and correlated problems across both devices. Findings contain supporting measurements, suspected cause, severity, service impact and investigation steps. An engineer can separately record a confirmed root cause. Active findings are deduplicated per device and rule; resolved findings remain in history. Thresholds are configurable through the `DIAG_*` variables in `.env.example`. Injection names are never passed to the diagnostic rules.

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

Open `http://127.0.0.1:5173/` and sign in. Vite proxies `/api` and `/socket.io` to the backend on port 4000. The Redundancy page shows heartbeat recency, active assignment, standby readiness and event history. Administrators can pause an active device's simulated heartbeat to demonstrate failover, then resume it; supervisors and administrators can request failback after primary recovery. Fault Diagnostics shows suspected causes and lets users record investigation results. Administrators can inject device or system scenarios in Simulation Laboratory. Scenario controls are local to this single API process and reset when it restarts. The desktop-first console supports light/dark themes, search and filters, and a collapsible sidebar. Live telemetry and status events invalidate the relevant REST queries; when the stream is unavailable the frontend polls every five seconds. Socket.IO events are transient, so reconnect re-fetches the durable current state from the API. The browser keeps the JWT in session storage, which clears when its tab session ends.

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
