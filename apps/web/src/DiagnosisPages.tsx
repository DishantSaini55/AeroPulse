import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { Activity, AlertTriangle, FlaskConical, RefreshCw } from 'lucide-react';
import { confirmDiagnosis, getDiagnoses, getSimulationDevices, setDeviceScenario, setSystemScenario, type Diagnosis } from './api';
import { formatUtcDateTime } from './time';
import './diagnostics.css';

const scenarios = ['NORMAL', 'DEGRADATION', 'FAILURE', 'RECOVERY', 'OVERHEATING', 'FAN_FAILURE', 'CPU_OVERLOAD', 'MEMORY_OVERLOAD', 'DISK_EXHAUSTION', 'NETWORK_DISCONNECTION', 'PACKET_LOSS', 'POWER_FAILURE', 'MISSING_HEARTBEAT'];

function Finding({ item, refresh }: { item: Diagnosis; refresh: () => void }) {
  const [rootCause, setRootCause] = useState(item.confirmedRootCause ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await confirmDiagnosis(item.id, rootCause.trim()); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save confirmation'); }
    finally { setBusy(false); }
  }
  return <article className="panel finding"><div className="panel-head"><div><span className="eyebrow">{item.device.system.code} / {item.device.code}</span><h2>{item.suspectedCause}</h2></div><span className={`badge badge-${item.severity === 'CRITICAL' ? 'red' : 'amber'}`}>{item.severity}</span></div>
    <div className="finding-body"><div><span className="finding-label">SUSPECTED COMPONENT</span><strong>{item.component}</strong></div><div><span className="finding-label">DETECTED (UTC)</span><strong>{formatUtcDateTime(item.detectedAt)}</strong></div><div><span className="finding-label">SERVICE IMPACT</span><strong>{item.serviceImpact}</strong></div><div><span className="finding-label">PREVIOUS SIMILAR</span><strong>{item.previousSimilarFailures}</strong></div></div>
    <div className="finding-evidence"><div><span className="finding-label">OBSERVED SYMPTOMS</span><p>{item.symptoms.join(' · ')}</p></div><div><span className="finding-label">SUPPORTING TELEMETRY</span><p className="mono">{Object.entries(item.supportingTelemetry).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'No direct measurement'}</p></div><div><span className="finding-label">INVESTIGATE</span><p>{item.investigationSteps.join(' · ')}</p></div><div><span className="finding-label">AUTOMATIC ACTION</span><p>{item.recoveryAction}</p></div></div>
    <form className="finding-confirm" onSubmit={submit}><label>Confirmed root cause <small>Record only after investigation</small><input value={rootCause} onChange={event => setRootCause(event.target.value)} minLength={5} maxLength={500} required placeholder="Enter verified root cause" /></label><button disabled={busy || rootCause.trim() === item.confirmedRootCause} type="submit">{busy ? 'Saving…' : 'Save confirmation'}</button>{item.confirmedBy && <span>Confirmed by {item.confirmedBy.name} · {formatUtcDateTime(item.confirmedAt)}</span>}{error && <div className="form-error" role="alert">{error}</div>}</form>
  </article>;
}

export function DiagnosticsPage() {
  const [filter, setFilter] = useState<'all' | 'true' | 'false'>('true');
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['diagnoses', filter], queryFn: () => getDiagnoses(filter), refetchInterval: 10000 });
  return <><div className="page-heading"><span className="eyebrow">OPERATIONS / FAULT ANALYSIS</span><h1>Fault diagnostics</h1><p>Rule based suspected causes from simulated readings. Engineer confirmation is recorded separately.</p></div><div className="toolbar"><div className="select-wrap"><select aria-label="Filter diagnoses" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="true">Active findings</option><option value="false">Resolved findings</option><option value="all">All findings</option></select></div><span className="result-count">{query.data?.length ?? 0} findings</span></div>{query.isPending ? <div className="state-panel"><RefreshCw className="spin" size={16} /> Loading diagnoses…</div> : query.error ? <div className="state-panel state-error">{query.error.message}</div> : query.data?.length ? <div className="finding-list">{query.data.map(item => <Finding key={item.id} item={item} refresh={() => void client.invalidateQueries({ queryKey: ['diagnoses'] })} />)}</div> : <div className="state-panel"><Activity size={17} /> No findings for this filter.</div>}</>;
}

export function SimulationLab() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['simulation-devices'], queryFn: getSimulationDevices });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function change(code: string, scenario: string) {
    setBusy(code); setError('');
    try { await setDeviceScenario(code, scenario); await client.invalidateQueries({ queryKey: ['simulation-devices'] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not apply scenario'); }
    finally { setBusy(''); }
  }
  async function changeShared(code: string, scenario: string) {
    setBusy(code); setError('');
    try { await setSystemScenario(code, scenario); await client.invalidateQueries({ queryKey: ['simulation-devices'] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not apply shared scenario'); }
    finally { setBusy(''); }
  }
  return <><div className="page-heading"><span className="eyebrow">ADMINISTRATION / SIMULATION</span><h1>Simulation laboratory</h1><p>Inject fictional symptoms into local devices. Diagnostics uses the resulting telemetry, not the scenario name.</p></div><div className="notice"><AlertTriangle size={16} /><strong>SIMULATED ONLY</strong><span>Scenarios affect this local API process and reset on restart.</span></div>{error && <div className="form-error users-message" role="alert">{error}</div>}{query.isPending ? <div className="state-panel"><RefreshCw className="spin" size={16} /> Loading devices…</div> : query.error ? <div className="state-panel state-error">{query.error.message}</div> : <><section className="panel shared-scenarios"><div className="panel-head"><div><span className="eyebrow">CORRELATED FAILURE DEMO</span><h2>Apply scenario to both devices</h2></div></div><div className="shared-grid">{Array.from(new Map(query.data?.map(device => [device.system.code, device.system])).values()).map(system => <label key={system.code}>{system.name}<select defaultValue="" disabled={!!busy} onChange={event => { void changeShared(system.code, event.target.value); event.target.value = ''; }}><option value="" disabled>Choose shared scenario</option><option value="NORMAL">Normal</option><option value="RECOVERY">Recovery</option><option value="MISSING_HEARTBEAT">Missing heartbeats</option>{!['UPS', 'COOLING'].includes(system.code) && <option value="NETWORK_DISCONNECTION">Network disconnection</option>}</select></label>)}</div></section><div className="table-wrap"><table><thead><tr><th>DEVICE</th><th>SYSTEM</th><th>ROLE</th><th>SCENARIO</th><th>HEARTBEAT</th></tr></thead><tbody>{query.data?.map(device => { const compute = ['AMSS', 'AUTOMATION', 'ASMGCS'].includes(device.system.code); const network = !['UPS', 'COOLING'].includes(device.system.code); return <tr key={device.code}><td><NavLink className="device-link" to={`/devices/${device.code}`}>{device.code}</NavLink></td><td>{device.system.name}</td><td>{device.role}</td><td><label className="scenario-select"><FlaskConical size={14} /><select aria-label={`Scenario for ${device.code}`} value={device.scenario} disabled={!!busy} onChange={event => void change(device.code, event.target.value)}>{scenarios.filter(scenario => (!['CPU_OVERLOAD', 'MEMORY_OVERLOAD', 'DISK_EXHAUSTION'].includes(scenario) || compute) && (!['PACKET_LOSS', 'NETWORK_DISCONNECTION'].includes(scenario) || network) && (scenario !== 'POWER_FAILURE' || device.system.code === 'UPS')).map(scenario => <option key={scenario} value={scenario}>{scenario.replaceAll('_', ' ')}</option>)}</select></label></td><td>{device.heartbeatPaused ? <span className="red-text">Paused</span> : 'Running'}</td></tr>; })}</tbody></table></div></>}</>;
}
