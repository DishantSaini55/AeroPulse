import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { ArrowUpRight, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import { getRedundancy } from './api';
import './redundancy.css';

const displayTime = (value: string | null) => value ? new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Never';

export function RedundancyPage({ now, streamConnected }: { now: number; streamConnected: boolean }) {
  const query = useQuery({ queryKey: ['redundancy'], queryFn: getRedundancy, refetchInterval: streamConnected ? 15000 : 5000 });
  const systems = query.data?.data ?? [];
  const available = systems.filter(item => item.availability === 'AVAILABLE').length;
  const ready = systems.filter(item => item.standbyReady).length;
  return <>
    <div className="page-heading"><span className="eyebrow">OPERATIONS / REDUNDANCY</span><h1>Heartbeat & redundancy</h1><p>Current active assignments and standby readiness across ten simulated logical systems.</p></div>
    <div className="notice neutral-notice"><ShieldCheck size={16} /><strong>MONITORING POLICY</strong><span>{query.data ? `Expected heartbeat every ${query.data.policy.expectedIntervalMs / 1000}s · unavailable after ${query.data.policy.missedHeartbeatLimit} missed intervals (${query.data.policy.timeoutMs / 1000}s).` : 'Loading heartbeat policy…'} Automatic failover is not enabled yet.</span></div>
    {query.isPending ? <div className="state-panel"><RefreshCw className="spin" size={16} /> Loading redundancy state…</div> : query.error ? <div className="state-panel state-error">{query.error.message}</div> : <>
      <div className="redundancy-summary"><div><span>AVAILABLE SERVICES</span><strong>{available}/{systems.length}</strong></div><div><span>READY STANDBYS</span><strong>{ready}/{systems.length}</strong></div><div><span>MONITOR CHECK</span><strong>{query.data && displayTime(query.data.recordedAt)}</strong></div></div>
      <div className="redundancy-list">{systems.map(system => <section className="panel redundancy-system" key={system.id}><div className="panel-head"><div><span className="eyebrow">{system.code}</span><h2>{system.name}</h2></div><span className={`badge badge-${system.availability === 'AVAILABLE' ? 'green' : system.availability === 'DEGRADED' ? 'amber' : 'red'}`}>{system.availability}</span></div>
        <div className="redundancy-devices">{system.devices.map(device => {
          const age = device.latestHeartbeatAt ? Math.max(0, Math.floor((now - new Date(device.latestHeartbeatAt).getTime()) / 1000)) : null;
          return <div className="redundancy-device" key={device.id}><span className="redundancy-role">{device.role === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY'}</span><NavLink to={`/devices/${device.code}`} className="device-link">{device.code} <ArrowUpRight size={13} /></NavLink><span className={`badge badge-${device.health === 'HEALTHY' ? 'green' : device.health === 'UNAVAILABLE' ? 'red' : 'amber'}`}>{device.health}</span><span className="redundancy-assignment">{device.activationState}</span><span className="redundancy-last">{age == null ? 'No heartbeat' : `${age}s ago`} · {displayTime(device.latestHeartbeatAt)}</span></div>;
        })}</div><div className="panel-foot redundancy-foot">{system.standbyReady ? <><ShieldCheck size={14} /> Standby ready</> : <><ShieldX size={14} /> No healthy standby</>}<span>Active: {system.activeDeviceCode ?? 'none'}</span></div></section>)}</div>
    </>}
  </>;
}
