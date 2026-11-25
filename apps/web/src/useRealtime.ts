import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { getToken } from './auth';

export type TelemetryEvent = { recordedAt: string; deviceCodes: string[]; simulated: true };

export function useRealtime() {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);

  useEffect(() => {
    const socket = io({ path: '/socket.io', autoConnect: false, auth: callback => callback({ token: getToken() }) });
    const sync = () => {
      setConnected(true);
      // Socket.IO events missed while disconnected are recovered from REST state.
      void queryClient.invalidateQueries({ queryKey: ['snapshot'] });
      void queryClient.invalidateQueries({ queryKey: ['history'] });
      void queryClient.invalidateQueries({ queryKey: ['redundancy'] });
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
    };
    const onStatus = () => {
      void queryClient.invalidateQueries({ queryKey: ['snapshot'] });
      void queryClient.invalidateQueries({ queryKey: ['redundancy'] });
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
    socket.connect();
    return () => {
      socket.off('connect', sync);
      socket.off('disconnect', disconnect);
      socket.off('connect_error', connectError);
      socket.off('telemetry:batch', onBatch);
      socket.off('status:changed', onStatus);
      socket.disconnect();
    };
  }, [queryClient]);

  return { connected, events };
}
