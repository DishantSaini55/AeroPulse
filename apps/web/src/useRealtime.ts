import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { getToken } from './auth';

export type TelemetryEvent = { recordedAt: string; deviceCodes: string[]; simulated: true };
export type AlarmNotice = { id: string; level: 'INFORMATION' | 'WARNING' | 'MAJOR' | 'CRITICAL'; message: string; deviceCode: string; createdAt: string; simulated: true };

export function useRealtime() {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [alarmNotices, setAlarmNotices] = useState<AlarmNotice[]>([]);

  useEffect(() => {
    // WebSocket avoids a multi-request polling session that would require proxy stickiness.
    const socket = io({ path: '/socket.io', transports: ['websocket'], autoConnect: false, auth: callback => callback({ token: getToken() }) });
    const sync = () => {
      setConnected(true);
      // Socket.IO events missed while disconnected are recovered from REST state.
      void queryClient.invalidateQueries({ queryKey: ['snapshot'] });
      void queryClient.invalidateQueries({ queryKey: ['history'] });
      void queryClient.invalidateQueries({ queryKey: ['redundancy'] });
      void queryClient.invalidateQueries({ queryKey: ['failover-events'] });
      void queryClient.invalidateQueries({ queryKey: ['alarms'] });
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    };
    const disconnect = () => setConnected(false);
    const onBatch = (event: unknown) => {
      if (!event || typeof event !== 'object') return;
      const candidate = event as Partial<TelemetryEvent>;
      if (candidate.simulated !== true || typeof candidate.recordedAt !== 'string' || !Array.isArray(candidate.deviceCodes) || !candidate.deviceCodes.every(code => typeof code === 'string')) return;
      setEvents(previous => [candidate as TelemetryEvent, ...previous].slice(0, 30));
      void queryClient.invalidateQueries({ queryKey: ['snapshot'] });
      void queryClient.invalidateQueries({ queryKey: ['history'] });
      void queryClient.invalidateQueries({ queryKey: ['redundancy'] });
      void queryClient.invalidateQueries({ queryKey: ['diagnoses'] });
    };
    const onStatus = () => {
      void queryClient.invalidateQueries({ queryKey: ['snapshot'] });
      void queryClient.invalidateQueries({ queryKey: ['redundancy'] });
      void queryClient.invalidateQueries({ queryKey: ['failover-events'] });
      void queryClient.invalidateQueries({ queryKey: ['diagnoses'] });
    };
    const onAlarm = (event: AlarmNotice) => {
      if (!event || event.simulated !== true || !['INFORMATION', 'WARNING', 'MAJOR', 'CRITICAL'].includes(event.level) || typeof event.id !== 'string') return;
      setAlarmNotices(previous => [event, ...previous].slice(0, 30));
      void queryClient.invalidateQueries({ queryKey: ['alarms'] });
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
    };
    const onIncident = () => {
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['maintenance'] });
    };
    socket.on('connect', sync);
    socket.on('disconnect', disconnect);
    const connectError = (error: Error) => {
      disconnect();
      if (error.message === 'Unauthorized') window.dispatchEvent(new Event('aeropulse:unauthorized'));
    };
    socket.on('connect_error', connectError);
    socket.on('telemetry:batch', onBatch);
    socket.on('status:changed', onStatus);
    socket.on('alarm:raised', onAlarm);
    socket.on('incident:changed', onIncident);
    const onMaintenance = () => {
      for (const key of ['maintenance','snapshot','redundancy','failover-events','analytics','recommendations']) void queryClient.invalidateQueries({ queryKey: [key] });
    };
    socket.on('maintenance:changed', onMaintenance);
    socket.on('notifications:changed', () => { void queryClient.invalidateQueries({ queryKey: ['notifications'] }); });
    socket.connect();
    return () => {
      socket.off('connect', sync);
      socket.off('disconnect', disconnect);
      socket.off('connect_error', connectError);
      socket.off('telemetry:batch', onBatch);
      socket.off('status:changed', onStatus);
      socket.off('alarm:raised', onAlarm);
      socket.off('incident:changed', onIncident);
      socket.off('maintenance:changed', onMaintenance);
      socket.off('notifications:changed');
      socket.disconnect();
    };
  }, [queryClient]);

  return { connected, events, alarmNotices };
}
