import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { ArrowUpRight, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import { getFailoverEvents, getRedundancy, requestFailback, setHeartbeatPaused } from './api';
import { formatUtcTime } from './time';
import { useAuth } from './auth';
import { useState } from 'react';
import './redundancy.css';

const displayTime = (value: string | null) => value ? formatUtcTime(value) : 'Never';

export function RedundancyPage({ now, streamConnected }: { now: number; streamConnected: boolean }) {
  const { user } = useAuth();
  const client = useQueryClient();
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const query = useQuery({ queryKey: ['redundancy'], queryFn: getRedundancy, refetchInterval: streamConnected ? 15000 : 5000 });
  const history = useQuery({ queryKey: ['failover-events'], queryFn: getFailoverEvents, refetchInterval: streamConnected ? 15000 : 5000 });
  async function act(key: string, operation: () => Promise<unknown>) {
    setBusy(key); setActionError('');
    try {
      await operation();
      await Promise.all([client.invalidateQueries({ queryKey: ['redundancy'] }), client.invalidateQueries({ queryKey: ['failover-events'] }), client.invalidateQueries({ queryKey: ['snapshot'] })]);
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Action failed'); }
    finally { setBusy(''); }
  }
  const systems = query.data?.data ?? [];
  const available = systems.filter(item => item.availability === 'AVAILABLE').length;
  const ready = systems.filter(item => item.standbyReady).length;
  return <>
    <div className="page-heading"><span className="eyebrow">OPERATIONS / REDUNDANCY</span><h1>Heartbeat & redundancy</h1><p>Current active assignments and standby readiness across ten simulated logical systems.</p></div>
    <div className="notice neutral-notice"><ShieldCheck size={16} /><strong>MONITORING POLICY</strong><span>{query.data ? `Expected heartbeat every ${query.data.policy.expectedIntervalMs / 1000}s · unavailable after ${query.data.policy.missedHeartbeatLimit} missed intervals (${query.data.policy.timeoutMs / 1000}s).` : 'Loading heartbeat policy…'} Healthy standby takes over automatically. Failback requires supervisor approval.</span></div>
    {actionError && <div className="form-error users-message" role="alert">{actionError}</div>}
    {query.isPending ? <div className="state-panel"><RefreshCw className="spin" size={16} /> Loading redundancy state…</div> : query.error ? <div className="state-panel state-error">{query.error.message}</div> : <>
      <div className="redundancy-summary"><div><span>AVAILABLE SERVICES</span><strong>{available}/{systems.length}</strong></div><div><span>READY STANDBYS</span><strong>{ready}/{systems.length}</strong></div><div><span>MONITOR CHECK</span><strong>{query.data && displayTime(query.data.recordedAt)}</strong></div></div>
      <div className="redundancy-list">{systems.map(system => <section className="panel redundancy-system" data-system={system.code} key={system.id}><div className="panel-head"><div><span className="eyebrow">{system.code}</span><h2>{system.name}</h2></div><span className={`badge badge-${system.availability === 'AVAILABLE' ? 'green' : system.availability === 'DEGRADED' ? 'amber' : 'red'}`}>{system.availability}</span></div>
        <div className="redundancy-devices">{system.devices.map(device => {
          const age = device.latestHeartbeatAt ? Math.max(0, Math.floor((now - new Date(device.latestHeartbeatAt).getTime()) / 1000)) : null;
          return <div className="redundancy-device" key={device.id}><span className="redundancy-role">{device.role === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY'}</span><NavLink to={`/devices/${device.code}`} className="device-link">{device.code} <ArrowUpRight size={13} /></NavLink><span className={`badge badge-${device.health === 'HEALTHY' ? 'green' : device.health === 'UNAVAILABLE' ? 'red' : 'amber'}`}>{device.health}</span><span className="redundancy-assignment">{device.activationState}</span><span className="redundancy-last">{age == null ? 'No heartbeat' : `${age}s ago`} · {displayTime(device.latestHeartbeatAt)}</span>{user?.role === 'ADMINISTRATOR' && <button className="redundancy-action" disabled={!!busy} onClick={() => void act(device.code, () => setHeartbeatPaused(device.code, !device.heartbeatPaused))}>{device.heartbeatPaused ? 'Resume heartbeat' : 'Pause heartbeat'}</button>}</div>;
        })}</div><div className="panel-foot redundancy-foot">{system.standbyReady ? <><ShieldCheck size={14} /> Standby ready</> : <><ShieldX size={14} /> No healthy standby</>}<span>Active: {system.activeDeviceCode ?? 'none'}</span></div>{system.lastFailover && <div className="redundancy-event">Last action: {system.lastFailover.action.replaceAll('_', ' ')} · {system.lastFailover.result} · {displayTime(system.lastFailover.detectedAt)}</div>}{(user?.role === 'ADMINISTRATOR' || user?.role === 'SUPERVISOR') && !system.devices.some(device => device.role === 'PRIMARY' && device.activationState === 'ACTIVE') && <div className="redundancy-actions"><button className="redundancy-action" disabled={!!busy || !system.devices.some(device => device.role === 'PRIMARY' && device.health === 'HEALTHY' && !device.heartbeatPaused && device.maintenanceEligible && device.maintenanceStatus === 'AVAILABLE' && !!device.latestHeartbeatAt && now - new Date(device.latestHeartbeatAt).getTime() >= 0 && now - new Date(device.latestHeartbeatAt).getTime() < (query.data?.policy.timeoutMs ?? 15000))} onClick={() => void act(system.code, () => requestFailback(system.code))}>Fail back to primary</button></div>}</section>)}</div>
      <section className="panel failover-history"><div className="panel-head"><div><span className="eyebrow">DURABLE EVENT LOG</span><h2>Failover history</h2></div></div>{history.isPending ? <div className="state-panel">Loading events…</div> : history.error ? <div className="state-panel state-error">{history.error.message}</div> : history.data?.length ? <div className="table-wrap"><table><thead><tr><th>TIME (UTC)</th><th>SYSTEM</th><th>ACTION</th><th>FROM → TO</th><th>RESULT</th><th>DURATION</th></tr></thead><tbody>{history.data.map(event => <tr key={event.id}><td>{displayTime(event.detectedAt)}</td><td>{event.system.code}</td><td>{event.action.replaceAll('_', ' ')}</td><td>{event.fromDevice?.code ?? '—'} → {event.toDevice?.code ?? '—'}</td><td>{event.result}</td><td>{event.durationMs} ms</td></tr>)}</tbody></table></div> : <div className="state-panel">No failover attempts recorded yet.</div>}</section>
    </>}
  </>;
}
