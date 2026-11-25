import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { Bell, BellOff, Volume2, VolumeX } from 'lucide-react';
import { acknowledgeAlarm, getAlarms, type Alarm } from './api';
import { formatUtcDateTime } from './time';
import type { AlarmNotice } from './useRealtime';
import './alarms.css';

export function AlarmBanner({ notices }: { notices: AlarmNotice[] }) {
  const query = useQuery({ queryKey: ['alarms', 'true'], queryFn: () => getAlarms('true'), refetchInterval: 10000 });
  const active = query.data ?? [];
  const activeErrorKeys = active.filter(alarm => alarm.level !== 'INFORMATION').map(alarm => `${alarm.id}:${alarm.level}`);
  const activeErrorKey = [...activeErrorKeys].sort().join('|');
  const highest = active.some(item => item.level === 'CRITICAL') ? 'CRITICAL' : active.some(item => item.level === 'MAJOR') ? 'MAJOR' : active.some(item => item.level === 'WARNING') ? 'WARNING' : 'INFORMATION';
  const [enabled, setEnabled] = useState(false);
  const [muted, setMuted] = useState(() => localStorage.getItem('ap-alarm-muted') === 'true');
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('ap-alarm-volume') ?? 0.5));
  const audio = useRef<HTMLAudioElement | null>(null);
  const seen = useRef(new Set<string>());
  const activeKeys = useRef(new Set(activeErrorKeys));
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  activeKeys.current = new Set(activeErrorKeys);
  function stopPlayback() {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    audio.current?.pause();
    if (audio.current) audio.current.currentTime = 0;
  }
  function stopCycle() {
    if (repeatTimer.current) clearInterval(repeatTimer.current);
    repeatTimer.current = null;
    stopPlayback();
  }
  function playTenSeconds() {
    if (!audio.current) return;
    stopPlayback();
    void audio.current.play().catch(error => console.error('Alarm audio playback failed', error));
    stopTimer.current = setTimeout(stopPlayback, 10000);
  }
  function startCycle() {
    stopCycle();
    playTenSeconds();
    repeatTimer.current = setInterval(() => {
      if (activeKeys.current.size) playTenSeconds();
      else stopCycle();
    }, 60000);
  }
  useEffect(() => { localStorage.setItem('ap-alarm-muted', String(muted)); localStorage.setItem('ap-alarm-volume', String(volume)); }, [muted, volume]);
  useEffect(() => {
    audio.current = new Audio('/alarm-error.mp3');
    audio.current.loop = true;
    return () => { stopCycle(); audio.current = null; };
  }, []);
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume]);
  useEffect(() => {
    const notice = notices[0];
    if (!notice || notice.level === 'INFORMATION' || !enabled || muted) return;
    const key = `${notice.id}:${notice.level}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    startCycle();
  }, [notices, enabled, muted, volume]);
  useEffect(() => {
    if (!enabled || muted) { stopCycle(); return; }
    if (!query.isSuccess) return;
    if (!activeErrorKeys.length) { stopCycle(); seen.current.clear(); return; }
    const newError = activeErrorKeys.some(key => !seen.current.has(key));
    activeErrorKeys.forEach(key => seen.current.add(key));
    if (newError || !repeatTimer.current) startCycle();
  }, [activeErrorKey, enabled, muted, query.isSuccess]);
  function enable() {
    if (!muted && activeErrorKeys.length) {
      activeErrorKeys.forEach(key => seen.current.add(key));
      startCycle();
    }
    setEnabled(true);
  }
  return <div className={`alarm-banner ${active.length ? `alarm-${highest.toLowerCase()}` : ''}`}><NavLink to="/alarms" className="alarm-banner-status">{active.length ? <Bell size={16} /> : <BellOff size={16} />}<strong>{active.length ? `${active.length} ACTIVE ALARM${active.length === 1 ? '' : 'S'}` : 'NO ACTIVE ALARMS'}</strong>{active.length > 0 && <span>{active[0]?.message}</span>}</NavLink><div className="alarm-controls">{!enabled ? <button onClick={enable}>Enable alarm sound</button> : <><button aria-label={muted ? 'Unmute alarms' : 'Mute alarms'} onClick={() => setMuted(value => !value)}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button><label>Volume <input aria-label="Alarm volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={event => setVolume(Number(event.target.value))} /></label></>}</div></div>;
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
