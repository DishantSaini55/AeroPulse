import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Antenna, ArrowLeft, ChevronDown, ChevronLeft, ChevronRight,
  Clock3, CloudSun, Database, ExternalLink, HardDrive, LayoutDashboard,
  Bell, FlaskConical, LogOut, Moon, Radio, RefreshCw, Search, Server, ShieldCheck, Stethoscope, Sun, Users, Wifi, WifiOff,
} from 'lucide-react';
import { getHistory, getSnapshot, getWeather, type Device, type Telemetry, type Weather } from './api';
import { useRealtime, type TelemetryEvent } from './useRealtime';
import { useAuth, type User } from './auth';
import { LoginPage, UsersPage } from './AuthPages';
import { RedundancyPage } from './RedundancyPage';
import { DiagnosticsPage, SimulationLab } from './DiagnosisPages';
import { AlarmBanner, AlarmPage } from './AlarmCenter';
import { formatUtcDateTime, formatUtcTime } from './time';

const TelemetryChart = lazy(() => import('./TelemetryChart'));

const stamp = formatUtcDateTime;
const shortTime = formatUtcTime;
const number = (value: number | null | undefined, unit = '', digits = 1) => value == null ? '—' : `${value.toFixed(digits)}${unit}`;
const fresh = (value: string | null, now: number) => !!value && now - new Date(value).getTime() < 20_000;
const roleLabel = (role: string) => role === 'SECONDARY' ? 'Standby' : 'Primary';

function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function DataState({ loading, error, empty, children }: { loading: boolean; error?: Error | null; empty?: boolean; children: React.ReactNode }) {
  if (loading) return <div className="state-panel"><RefreshCw size={18} className="spin" /><span>Loading operational data…</span></div>;
  if (error) return <div className="state-panel state-error"><WifiOff size={18} /><span>Data unavailable: {error.message}. Check that the API is running on port 4000.</span></div>;
  if (empty) return <div className="state-panel">No records available yet.</div>;
  return <>{children}</>;
}

function Metric({ label, value, note, tone }: { label: string; value: string; note: string; tone?: string }) {
  return <div className="metric"><div className="metric-label">{label}</div><div className={`metric-value ${tone ?? ''}`}>{value}</div><div className="metric-note">{note}</div></div>;
}

function WeatherPanel({ weather, loading, error, compact = false }: { weather?: Weather; loading: boolean; error?: Error | null; compact?: boolean }) {
  return <section className={`panel weather-panel ${compact ? 'compact' : ''}`}>
    <div className="panel-head"><div><span className="eyebrow">EXTERNAL OBSERVATION</span><h2>Delhi aviation weather <span className="muted">/ VIDP</span></h2></div><CloudSun size={20} className="panel-icon" /></div>
    <DataState loading={loading} error={error}>
      {weather && !weather.data && <div className="state-panel state-error">No VIDP observation is cached. {weather.lastError ?? 'Weather data is unavailable.'}</div>}
      {weather?.data && <>
        <div className="weather-main"><strong>{number(weather.data.temperatureC, '°C', 0)}</strong><span>{weather.data.conditions ?? 'No significant weather reported'}</span><Badge tone={weather.stale ? 'amber' : 'green'}>{weather.stale ? 'STALE' : 'CURRENT'}</Badge></div>
        <div className="weather-grid">
          <div><span>VISIBILITY</span><strong>{number(weather.data.visibilityMiles, ' mi', 2)}</strong></div>
          <div><span>WIND</span><strong>{weather.data.windDirectionDeg == null ? '—' : `${weather.data.windDirectionDeg}°`} / {number(weather.data.windSpeedKnots, ' kt', 0)}</strong></div>
          <div><span>PRESSURE</span><strong>{number(weather.data.pressureHpa, ' hPa', 0)}</strong></div>
          <div><span>DEW POINT</span><strong>{number(weather.data.dewPointC, '°C', 0)}</strong></div>
        </div>
        <div className="panel-foot">Observed {stamp(weather.data.observedAt)} · Fetched {stamp(weather.data.fetchedAt)}{weather.stale ? ` · ${weather.staleReasons.join(', ')}` : ''}</div>
      </>}
    </DataState>
  </section>;
}

function Overview({ devices, loading, error, weather, weatherLoading, weatherError, now, events, streamConnected }: { devices: Device[]; loading: boolean; error?: Error | null; weather?: Weather; weatherLoading: boolean; weatherError?: Error | null; now: number; events: TelemetryEvent[]; streamConnected: boolean }) {
  const systems = new Set(devices.map(device => device.system.code)).size;
  const active = devices.filter(device => device.activationState === 'ACTIVE').length;
  const reporting = devices.filter(device => fresh(device.latestHeartbeatAt, now)).length;
  const latest = [...devices].filter(device => device.latestTelemetry).sort((a, b) => new Date(b.latestTelemetry!.recordedAt).getTime() - new Date(a.latestTelemetry!.recordedAt).getTime()).slice(0, 6);
  return <>
    <PageHeading eyebrow="OPERATIONS / OVERVIEW" title="Infrastructure overview" subtitle="Current registry and recent simulated measurements across CNS and support systems." />
    <div className="notice"><span className="notice-mark" /> <strong>SIMULATION ENVIRONMENT</strong><span>Equipment readings are generated locally. Weather is sourced separately from Aviation Weather Center.</span></div>
    <DataState loading={loading} error={error}>
      <div className="metrics-strip">
        <Metric label="LOGICAL SYSTEMS" value={String(systems)} note="registered services" />
        <Metric label="SIMULATED DEVICES" value={String(devices.length)} note="primary + standby" />
        <Metric label="ACTIVE ASSIGNMENTS" value={String(active)} note="registry state; no failover yet" />
        <Metric label="RECENT HEARTBEATS" value={`${reporting}/${devices.length}`} note="received within 20 seconds" tone={reporting < devices.length ? 'amber-text' : 'green-text'} />
      </div>
      <div className="overview-grid">
        <section className="panel"><div className="panel-head"><div><span className="eyebrow">SYSTEM REGISTER</span><h2>Operational inventory</h2></div><NavLink to="/infrastructure" className="text-link">View all <ChevronRight size={15} /></NavLink></div>
          <div className="system-list">{Array.from(new Map(devices.map(device => [device.system.code, device.system])).values()).map(system => {
            const members = devices.filter(device => device.system.code === system.code);
            const reportingMembers = members.filter(device => fresh(device.latestHeartbeatAt, now)).length;
            return <NavLink to={`/infrastructure?system=${system.code}`} className="system-row" key={system.code}><span className="system-symbol"><Radio size={17} /></span><span className="system-name"><strong>{system.name}</strong><small>{system.code} · {members.length} devices</small></span><Badge tone={reportingMembers === members.length ? 'green' : 'amber'}>{reportingMembers}/{members.length} reporting</Badge><ChevronRight size={16} className="muted" /></NavLink>;
          })}</div>
        </section>
        <div className="side-stack"><WeatherPanel weather={weather} loading={weatherLoading} error={weatherError} compact />
          <section className="panel"><div className="panel-head"><div><span className="eyebrow">LATEST SIMULATED DATA</span><h2>Recent readings</h2></div><Activity size={18} className="panel-icon" /></div>
            <div className="reading-list">{latest.map(device => <NavLink to={`/devices/${device.code}`} className="reading-row" key={device.code}><span><strong>{device.code}</strong><small>{device.system.name}</small></span><span className="reading-values">{number(device.latestTelemetry?.temperatureC, '°C')}<small>{device.latestTelemetry && shortTime(device.latestTelemetry.recordedAt)}</small></span></NavLink>)}</div>
          </section></div>
      </div>
      <section className="panel event-console"><div className="panel-head"><div><span className="eyebrow">LIVE EVENT CONSOLE</span><h2>Telemetry stream</h2></div><Badge tone={streamConnected ? 'green' : 'amber'}>{streamConnected ? 'CONNECTED' : 'POLLING FALLBACK'}</Badge></div>
        {events.length === 0 ? <div className="console-empty">{streamConnected ? 'Waiting for the next simulated telemetry batch…' : 'Stream disconnected. Current state continues through REST polling.'}</div> : <div className="console-list">{events.map((event, index) => <div className="console-line" key={`${event.recordedAt}-${index}`}><span className="mono muted">{shortTime(event.recordedAt)}</span><span className="console-type">TELEMETRY</span><span>Batch persisted for {event.deviceCodes.length} simulated devices</span><span className="console-source">SIMULATION</span></div>)}</div>}
      </section>
    </DataState>
  </>;
}

function PageHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return <div className="page-heading"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>;
}

function Infrastructure({ devices, loading, error, now }: { devices: Device[]; loading: boolean; error?: Error | null; now: number }) {
  const params = new URLSearchParams(window.location.search);
  const initialSystem = params.get('system') ?? 'ALL';
  const [system, setSystem] = useState(initialSystem);
  const [role, setRole] = useState('ALL');
  const [search, setSearch] = useState('');
  const systems = [...new Set(devices.map(device => device.system.code))];
  const filtered = useMemo(() => devices.filter(device =>
    (system === 'ALL' || device.system.code === system) &&
    (role === 'ALL' || device.role === role) &&
    `${device.name} ${device.code} ${device.system.name}`.toLowerCase().includes(search.toLowerCase()),
  ), [devices, role, search, system]);
  return <>
    <PageHeading eyebrow="OPERATIONS / ASSETS" title="Infrastructure monitoring" subtitle="Twenty simulated assets grouped into ten logical services. Select any device for its measured history." />
    <div className="toolbar"><label className="search-field"><Search size={16} /><input aria-label="Search devices" placeholder="Search device or system" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="select-wrap"><select aria-label="Filter by system" value={system} onChange={event => setSystem(event.target.value)}><option value="ALL">All systems</option>{systems.map(code => <option key={code} value={code}>{code}</option>)}</select><ChevronDown size={14} /></div><div className="select-wrap"><select aria-label="Filter by role" value={role} onChange={event => setRole(event.target.value)}><option value="ALL">All roles</option><option value="PRIMARY">Primary</option><option value="SECONDARY">Standby</option></select><ChevronDown size={14} /></div><span className="result-count">{filtered.length} devices</span></div>
    <DataState loading={loading} error={error} empty={filtered.length === 0}>
      <div className="table-wrap"><table><thead><tr><th>DEVICE</th><th>LOGICAL SYSTEM</th><th>ROLE</th><th>ASSIGNMENT</th><th>HEARTBEAT</th><th>TEMPERATURE</th><th>LAST SAMPLE</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{filtered.map(device => <tr key={device.id}><td><NavLink className="device-link" to={`/devices/${device.code}`}>{device.code}</NavLink><div className="sub-cell">{device.name}</div></td><td>{device.system.name}</td><td>{roleLabel(device.role)}</td><td><Badge tone={device.activationState === 'ACTIVE' ? 'blue' : 'neutral'}>{device.activationState}</Badge></td><td><span className={`status-inline ${fresh(device.latestHeartbeatAt, now) ? 'ok' : 'warn'}`}><span className="status-dot" />{fresh(device.latestHeartbeatAt, now) ? 'Recent' : 'Delayed'}</span></td><td className="mono">{number(device.latestTelemetry?.temperatureC, '°C')}</td><td className="mono muted">{device.latestTelemetry ? shortTime(device.latestTelemetry.recordedAt) : '—'}</td><td><NavLink aria-label={`View ${device.code}`} to={`/devices/${device.code}`} className="row-action"><ChevronRight size={17} /></NavLink></td></tr>)}</tbody></table></div>
    </DataState>
    <p className="table-note">Heartbeat recency is based on receipt time. Device health and service availability currently reflect registry state; automatic fault detection is a later phase.</p>
  </>;
}

const metricFields: { key: keyof Telemetry; label: string; unit: string; color: string }[] = [
  { key: 'temperatureC', label: 'Temperature', unit: '°C', color: '#d79d59' },
  { key: 'cpuPercent', label: 'CPU utilization', unit: '%', color: '#65a5c9' },
  { key: 'memoryPercent', label: 'Memory utilization', unit: '%', color: '#75b8a0' },
  { key: 'latencyMs', label: 'Network latency', unit: 'ms', color: '#c5977c' },
  { key: 'packetLossPct', label: 'Packet loss', unit: '%', color: '#d37d7d' },
  { key: 'voltageV', label: 'Voltage', unit: 'V', color: '#a8a8c9' },
  { key: 'batteryPct', label: 'Battery', unit: '%', color: '#a7c783' },
  { key: 'signalPct', label: 'Signal quality', unit: '%', color: '#72b6b0' },
  { key: 'fanRpm', label: 'Fan speed', unit: 'rpm', color: '#8daaca' },
  { key: 'diskPercent', label: 'Disk utilization', unit: '%', color: '#a3a2c1' },
  { key: 'currentA', label: 'Current', unit: 'A', color: '#b6a57f' },
];

function DeviceDetail({ devices, now, loading, error, streamConnected }: { devices: Device[]; now: number; loading: boolean; error?: Error | null; streamConnected: boolean }) {
  const { code = '' } = useParams();
  const device = devices.find(item => item.code === code.toUpperCase());
  const history = useQuery({ queryKey: ['history', code], queryFn: () => getHistory(code), refetchInterval: streamConnected ? false : 5000, enabled: !!device });
  const available = metricFields.filter(field => history.data?.data.some(row => row[field.key] != null));
  const [selected, setSelected] = useState('temperatureC');
  const metric = available.find(field => field.key === selected) ?? available[0];
  const chart = history.data?.data.slice().reverse().map(row => ({ time: shortTime(row.recordedAt), value: metric ? row[metric.key] : null })) ?? [];
  if (loading || error) return <DataState loading={loading} error={error}>{null}</DataState>;
  if (!device) return <div className="state-panel">Device not found. <NavLink to="/infrastructure" className="text-link">Back to infrastructure</NavLink></div>;
  return <><NavLink to="/infrastructure" className="back-link"><ArrowLeft size={15} /> Infrastructure</NavLink>
    <PageHeading eyebrow={`ASSET / ${device.system.code}`} title={device.name} subtitle={`${device.code} · ${device.system.name} · simulated device`} />
    <div className="detail-strip"><div><span>REDUNDANCY ROLE</span><strong>{roleLabel(device.role)}</strong></div><div><span>ASSIGNMENT</span><strong>{device.activationState}</strong></div><div><span>LAST HEARTBEAT</span><strong className={fresh(device.latestHeartbeatAt, now) ? 'green-text' : 'amber-text'}>{stamp(device.latestHeartbeatAt)}</strong></div><div><span>REGISTRY HEALTH</span><strong>{device.health}</strong></div></div>
    <DataState loading={history.isPending} error={history.error} empty={!history.data?.data.length}>
      <section className="panel chart-panel"><div className="panel-head"><div><span className="eyebrow">SIMULATED TELEMETRY</span><h2>Historical readings</h2></div><div className="select-wrap"><select aria-label="Select telemetry metric" value={metric?.key ?? ''} onChange={event => setSelected(event.target.value)}>{available.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select><ChevronDown size={14} /></div></div>
        <div className="chart-box">{metric && <Suspense fallback={<div className="state-panel">Loading chart…</div>}><TelemetryChart data={chart} metric={metric} /></Suspense>}</div>
        <div className="panel-foot">Latest {history.data && stamp(history.data.data[0]?.recordedAt)} · {history.data?.total ?? 0} stored readings · Showing last {history.data?.data.length ?? 0}</div>
      </section>
      <div className="metric-grid">{available.map(field => <div className="small-metric" key={field.key}><span>{field.label}</span><strong>{number(history.data?.data[0]?.[field.key] as number | null | undefined, field.unit)}</strong></div>)}</div>
    </DataState>
  </>;
}

function WeatherPage({ weather, loading, error }: { weather?: Weather; loading: boolean; error?: Error | null }) {
  return <><PageHeading eyebrow="EXTERNAL DATA / AVIATION WEATHER" title="Aviation weather" subtitle="Latest available METAR observation for Indira Gandhi International Airport (VIDP)." /><div className="notice neutral-notice"><CloudSun size={16} /><strong>REAL OBSERVATION</strong><span>Sourced from the public Aviation Weather Center. This is separate from simulated equipment data.</span></div><WeatherPanel weather={weather} loading={loading} error={error} /><section className="panel raw-panel"><div className="panel-head"><div><span className="eyebrow">SOURCE REPORT</span><h2>Raw METAR</h2></div><a className="text-link" href="https://aviationweather.gov/api/data/metar?ids=VIDP&format=json" target="_blank" rel="noreferrer">AWC source <ExternalLink size={14} /></a></div><code>{weather?.data?.rawMetar ?? 'No observation available'}</code></section></>;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-screen auth-loading"><RefreshCw className="spin" size={22} /> Checking session…</div>;
  if (!user) return <LoginPage />;
  return <OperationsApp user={user} />;
}

function OperationsApp({ user }: { user: User }) {
  const { logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('ap-sidebar') === 'collapsed');
  const [theme, setTheme] = useState(() => localStorage.getItem('ap-theme') ?? 'dark');
  const now = useClock();
  const realtime = useRealtime();
  const snapshot = useQuery({ queryKey: ['snapshot'], queryFn: getSnapshot, refetchInterval: realtime.connected ? false : 5000 });
  const weather = useQuery({ queryKey: ['weather'], queryFn: getWeather, refetchInterval: 5 * 60_000 });
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('ap-theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('ap-sidebar', collapsed ? 'collapsed' : 'expanded'); }, [collapsed]);
  const devices = snapshot.data?.data ?? [];
  const navigation = [
    { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/infrastructure', label: 'Infrastructure', icon: Server, end: false },
    { to: '/redundancy', label: 'Redundancy', icon: ShieldCheck, end: false },
    { to: '/diagnostics', label: 'Fault diagnostics', icon: Stethoscope, end: false },
    { to: '/alarms', label: 'Alarm center', icon: Bell, end: false },
    { to: '/weather', label: 'Aviation weather', icon: CloudSun, end: false },
    ...(user.role === 'ADMINISTRATOR' ? [{ to: '/users', label: 'User management', icon: Users, end: false }] : []),
    ...(user.role === 'ADMINISTRATOR' ? [{ to: '/simulation', label: 'Simulation lab', icon: FlaskConical, end: false }] : []),
  ];
  return <div className={`shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Antenna size={19} strokeWidth={2.1} /></div><div className="brand-copy"><strong>AeroPulse</strong><span>OPERATIONS CONSOLE</span></div></div>
      <div className="nav-caption">WORKSPACE</div><nav aria-label="Primary navigation">{navigation.map(({ to, label, icon: Icon, end }) => <NavLink to={to} end={end} key={to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} title={collapsed ? label : undefined}><Icon size={17} /><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="environment"><span className="env-dot" /><div><strong>SIMULATION</strong><span>Local environment</span></div></div><div className="sidebar-account" title={`${user.name} · ${user.email}`}><strong>{user.name}</strong><span>{user.role.replaceAll('_', ' ').toLowerCase()}</span></div><button className="collapse-button" onClick={logout} aria-label="Sign out"><LogOut size={16} /><span>Sign out</span></button><button className="collapse-button" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}<span>{collapsed ? '' : 'Collapse sidebar'}</span></button></div>
    </aside>
    <div className="main-area"><header className="topbar"><div className="topbar-title"><span className="topbar-path">AEROPULSE</span><span className="topbar-divider">/</span><span>Operations workspace</span></div><div className="topbar-actions"><span className={`connection ${snapshot.isError ? 'disconnected' : ''}`}>{snapshot.isError ? <WifiOff size={14} /> : <Wifi size={14} />}{snapshot.isError ? 'API DISCONNECTED' : realtime.connected ? 'LIVE STREAM' : 'POLLING FALLBACK'}</span><span className="topbar-time"><Clock3 size={14} /> {formatUtcTime(now, false)}</span><button className="icon-button" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button></div></header>
      <AlarmBanner notices={realtime.alarmNotices} /><main className="content"><Routes><Route path="/" element={<Overview devices={devices} loading={snapshot.isPending} error={snapshot.error} weather={weather.data} weatherLoading={weather.isPending} weatherError={weather.error} now={now} events={realtime.events} streamConnected={realtime.connected} />} /><Route path="/infrastructure" element={<Infrastructure devices={devices} loading={snapshot.isPending} error={snapshot.error} now={now} />} /><Route path="/redundancy" element={<RedundancyPage now={now} streamConnected={realtime.connected} />} /><Route path="/diagnostics" element={<DiagnosticsPage />} /><Route path="/alarms" element={<AlarmPage />} /><Route path="/devices/:code" element={<DeviceDetail devices={devices} now={now} loading={snapshot.isPending} error={snapshot.error} streamConnected={realtime.connected} />} /><Route path="/weather" element={<WeatherPage weather={weather.data} loading={weather.isPending} error={weather.error} />} />{user.role === 'ADMINISTRATOR' && <Route path="/users" element={<UsersPage />} />}{user.role === 'ADMINISTRATOR' && <Route path="/simulation" element={<SimulationLab />} />}<Route path="*" element={<Navigate to="/" replace />} /></Routes></main>
      <footer className="footer"><span><span className="footer-led" /> AEROPULSE / INDEPENDENT SIMULATION</span><span>Equipment data: simulated · Weather: external observation</span></footer>
    </div>
  </div>;
}
