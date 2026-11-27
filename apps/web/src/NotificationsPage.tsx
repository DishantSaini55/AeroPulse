import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { getNotificationPreferences, getNotifications, markAllNotificationsRead, markNotificationRead, updateNotificationPreferences } from './api';
import { formatUtcDateTime } from './time';

export function NotificationsPage() {
  const client = useQueryClient(); const [onlyUnread, setOnlyUnread] = useState(false); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const notices = useQuery({ queryKey: ['notifications', onlyUnread], queryFn: () => getNotifications(onlyUnread ? true : undefined), refetchInterval: 15000 });
  const preferences = useQuery({ queryKey: ['notification-preferences'], queryFn: getNotificationPreferences });
  const refresh = async () => { await client.invalidateQueries({ queryKey: ['notifications'] }); };
  const markAll = async () => { setBusy(true); setMessage(''); try { await markAllNotificationsRead(); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to update notifications'); } finally { setBusy(false); } };
  const update = async (input: Parameters<typeof updateNotificationPreferences>[0]) => {
    const previous = client.getQueryData<{ data: Awaited<ReturnType<typeof updateNotificationPreferences>> }>(['notification-preferences']);
    if (previous) client.setQueryData(['notification-preferences'], { data: { ...previous.data, ...input } });
    try { const saved = await updateNotificationPreferences(input); client.setQueryData(['notification-preferences'], { data: saved }); }
    catch (error) { if (previous) client.setQueryData(['notification-preferences'], previous); setMessage(error instanceof Error ? error.message : 'Unable to save preferences'); }
  };
  const markOne = async (id: string) => { setMessage(''); try { await markNotificationRead(id); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to mark notification read'); } };
  return <><div className="page-heading"><span className="eyebrow">OPERATIONS / NOTIFICATIONS</span><h1>Notification inbox</h1><p>Durable in-app delivery and read state. Reading an item never acknowledges or resolves its alarm.</p></div>
    <section className="panel notification-settings"><div><strong>In-app delivery</strong><small>External channels are disabled. Preferences apply to newly addressed events.</small></div><label><input type="checkbox" checked={preferences.data?.data.inAppEnabled ?? true} onChange={event => void update({ inAppEnabled: event.target.checked })} /> Enabled</label><label>Minimum priority <select value={preferences.data?.data.minimumPriority ?? 'INFORMATION'} onChange={event => void update({ minimumPriority: event.target.value as 'INFORMATION' | 'WARNING' | 'MAJOR' | 'CRITICAL' })}>{['INFORMATION','WARNING','MAJOR','CRITICAL'].map(value => <option key={value}>{value}</option>)}</select></label></section>
    <div className="toolbar"><label><input type="checkbox" checked={onlyUnread} onChange={event => setOnlyUnread(event.target.checked)} /> Unread only</label><span className="result-count">{notices.data?.unread ?? 0} unread</span><button className="status-button" disabled={busy || !(notices.data?.unread)} onClick={() => void markAll()}><CheckCheck size={15} /> Mark all read</button></div>{message && <p className="form-error" role="alert">{message}</p>}
    {notices.isPending ? <div className="state-panel">Loading notifications…</div> : notices.error ? <div className="state-panel state-error">{notices.error.message}</div> : notices.data?.data.length ? <section className="panel notification-list">{notices.data.data.map(item => <article key={item.id} className={`notification-row ${item.readAt ? '' : 'unread'}`}><Bell size={17} /><div><span className={`badge badge-${item.event.priority === 'CRITICAL' ? 'red' : item.event.priority === 'MAJOR' || item.event.priority === 'WARNING' ? 'amber' : 'blue'}`}>{item.event.priority}</span><strong>{item.event.title}</strong><p>{item.event.body}</p><small>{item.event.device ? `${item.event.device.system.code} / ${item.event.device.code} · ` : ''}{formatUtcDateTime(item.event.createdAt)} · {item.deliveries[0]?.status ?? 'PENDING'}</small></div>{!item.readAt && <button className="status-button" onClick={() => void markOne(item.id)}>Mark read</button>}</article>)}</section> : <div className="state-panel">No notifications match this view.</div>}</>;
}
