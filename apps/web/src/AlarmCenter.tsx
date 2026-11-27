import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { Bell, BellOff, Settings2, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';
import { acknowledgeAlarm, getAlarms, type Alarm } from './api';
import { formatUtcDateTime } from './time';
import type { AlarmNotice } from './useRealtime';
import { AlarmAudioManager, type AlarmLevel, type AudioPreferences, loadAudioPreferences, saveAudioPreferences } from './alarmAudio';
import './alarms.css';
import { useAuth } from './auth';
import { getMaintenanceAnnouncements, maintenanceAudioNotice } from './maintenanceAnnouncements';

function AudioPreferencesPanel({ preferences, update, manager }: { preferences: AudioPreferences; update: (next: Partial<AudioPreferences>) => void; manager: AlarmAudioManager }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const refresh = () => setVoices(manager.voices());
    refresh();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener?.('voiceschanged', refresh);
    return () => { if (typeof speechSynthesis !== 'undefined') speechSynthesis.removeEventListener?.('voiceschanged', refresh); };
  }, [manager]);
  const test = async (level: AlarmLevel) => { await manager.activate(); manager.playPattern(level); };
  return <div className="alarm-preferences" role="dialog" aria-label="Alarm audio preferences">
    <strong>Alarm audio preferences</strong><small>Settings are local to this browser and never change alarm acknowledgement or incident state.</small>
    <button onClick={() => void manager.activate()}> {manager.ready ? 'Audio enabled' : 'Enable audio'} </button>
    <label><input type="checkbox" checked={preferences.soundEnabled} onChange={event => update({ soundEnabled: event.target.checked })} /> Enable alarm sound</label>
    <label><input type="checkbox" checked={preferences.voiceEnabled} onChange={event => update({ voiceEnabled: event.target.checked })} disabled={!manager.voiceSupported} /> Voice announcements {manager.voiceSupported ? 'available' : 'unavailable'}</label>
    <label>Master volume <input type="range" min="0" max="1" step="0.05" value={preferences.masterVolume} onChange={event => update({ masterVolume: Number(event.target.value) })} /></label>
    <label>Voice volume <input type="range" min="0" max="1" step="0.05" value={preferences.voiceVolume} onChange={event => update({ voiceVolume: Number(event.target.value) })} /></label>
    <label>Speech rate <input type="range" min="0.7" max="1.2" step="0.05" value={preferences.speechRate} onChange={event => update({ speechRate: Number(event.target.value) })} /></label>
    {voices.length > 0 && <label>Voice <select value={preferences.voiceName} onChange={event => update({ voiceName: event.target.value })}><option value="">English browser default</option>{voices.filter(voice => /^en/i.test(voice.lang)).map(voice => <option key={voice.voiceURI} value={voice.name}>{voice.name}</option>)}</select></label>}
    <div className="alarm-test-actions"><button onClick={() => void test('WARNING')}>Test warning</button><button onClick={() => void test('MAJOR')}>Test major</button><button onClick={() => void test('CRITICAL')}>Test critical</button><button onClick={() => { if (manager.voiceSupported) { speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance('Simulation test. Alarm voice announcements are enabled.'); utterance.volume = preferences.voiceVolume; utterance.rate = preferences.speechRate; speechSynthesis.speak(utterance); } }}>Test voice</button></div>
  </div>;
}

export function AlarmBanner({ notices, connected }: { notices: AlarmNotice[]; connected: boolean }) {
  const { user } = useAuth();
  const query = useQuery({ queryKey: ['alarms', 'true'], queryFn: () => getAlarms('true'), refetchInterval: 10000 });
  const maintenance = useQuery({ queryKey: ['maintenance','announcements',user?.id], queryFn: getMaintenanceAnnouncements, refetchInterval: 15000 });
  const active = query.data ?? [];
  const highest = active.some(item => item.level === 'CRITICAL') ? 'CRITICAL' : active.some(item => item.level === 'MAJOR') ? 'MAJOR' : active.some(item => item.level === 'WARNING') ? 'WARNING' : 'INFORMATION';
  const [preferences, setPreferences] = useState(loadAudioPreferences);
  const [showPreferences, setShowPreferences] = useState(false);
  const preferenceRef = useRef(preferences); preferenceRef.current = preferences;
  const manager = useMemo(() => new AlarmAudioManager(() => preferenceRef.current, user?.id ?? 'local'), [user?.id]);
  const update = (next: Partial<AudioPreferences>) => setPreferences(current => ({ ...current, ...next, severities: { ...current.severities, ...next.severities } }));
  useEffect(() => { saveAudioPreferences(preferences); manager.setPreferencesChanged(); if (preferences.muted) manager.stopAll(); }, [preferences, manager]);
  useEffect(() => () => manager.destroy(), [manager]);
  useEffect(() => {
    if (!query.data) return;
    for (const notice of notices) {
      const alarm = query.data.find(item => item.id === notice.id);
      if (alarm) manager.enqueue({ ...alarm, failover: alarm.device.system.failover });
    }
  }, [notices, query.data, manager]);
  useEffect(() => { for (const notice of maintenance.data?.data ?? []) manager.enqueue(maintenanceAudioNotice(notice)); }, [maintenance.data, manager]);
  useEffect(() => { if (query.data) manager.reconcileActiveAlarms(query.data); }, [query.data, manager]);
  const critical = active.filter(item => item.level === 'CRITICAL').length;
  const unacknowledgedMajor = active.filter(item => item.level === 'MAJOR' && !item.acknowledged).length;
  return <div className={`alarm-banner ${active.length ? `alarm-${highest.toLowerCase()}` : ''}`}><NavLink to="/alarms" className="alarm-banner-status">{active.length ? <Bell size={16} /> : <BellOff size={16} />}<strong>{active.length ? `${active.length} ACTIVE · ${critical} CRITICAL · ${unacknowledgedMajor} UNACK MAJOR` : 'NO ACTIVE ALARMS'}</strong>{active.length > 0 && <span>{active[0]?.message}</span>}</NavLink><div className="alarm-controls"><span title={connected ? 'Socket.IO connected' : 'Socket.IO reconnecting'}>{connected ? <Wifi size={15} /> : <WifiOff size={15} />}</span><button aria-label={preferences.muted ? 'Unmute alarms' : 'Mute alarms'} onClick={() => update({ muted: !preferences.muted })}>{preferences.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button><button aria-label="Alarm audio preferences" onClick={() => setShowPreferences(value => !value)}><Settings2 size={16} /></button>{showPreferences && <AudioPreferencesPanel preferences={preferences} update={update} manager={manager} />}</div></div>;
}

function AlarmRow({ alarm }: { alarm: Alarm }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function acknowledge() {
    setBusy(true); setError('');
    try { await acknowledgeAlarm(alarm.id); await client.invalidateQueries({ queryKey: ['alarms'] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Acknowledgement failed'); }
    finally { setBusy(false); }
  }
  return <article className="alarm-row"><div className="alarm-row-main"><span className={`badge badge-${alarm.level === 'CRITICAL' ? 'red' : alarm.level === 'MAJOR' || alarm.level === 'WARNING' ? 'amber' : 'blue'}`}>{alarm.level}</span><div><strong>{alarm.device.system.code} / {alarm.device.code}</strong><p>{alarm.message}</p><small>{formatUtcDateTime(alarm.createdAt)} · {alarm.resolvedAt ? `Resolved ${formatUtcDateTime(alarm.resolvedAt)}` : 'Fault active'}{alarm.acknowledgedBy ? ` · Acknowledged by ${alarm.acknowledgedBy}` : ''}</small></div></div>{!alarm.acknowledgedByMe && <button disabled={busy} onClick={() => void acknowledge()}>{busy ? 'Saving…' : 'Acknowledge'}</button>}{error && <div className="form-error" role="alert">{error}</div>}</article>;
}

export function AlarmPage() {
  const [filter, setFilter] = useState<'true' | 'false' | 'all'>('true');
  const query = useQuery({ queryKey: ['alarms', filter], queryFn: () => getAlarms(filter), refetchInterval: 10000 });
  return <><div className="page-heading"><span className="eyebrow">OPERATIONS / NOTIFICATIONS</span><h1>Alarm center</h1><p>Simulated fault alerts, acknowledgements and recovery history. Acknowledging does not resolve the fault.</p></div><div className="toolbar"><div className="select-wrap"><select aria-label="Filter alarms" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="true">Active alarms</option><option value="false">Resolved history</option><option value="all">All alarms</option></select></div><span className="result-count">{query.data?.length ?? 0} alarms</span></div>{query.isPending ? <div className="state-panel">Loading alarms…</div> : query.error ? <div className="state-panel state-error">{query.error.message}</div> : query.data?.length ? <section className="panel">{query.data.map(alarm => <AlarmRow key={alarm.id} alarm={alarm} />)}</section> : <div className="state-panel">No alarms for this filter.</div>}</>;
}
