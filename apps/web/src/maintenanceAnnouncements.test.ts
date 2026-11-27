import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { maintenanceAudioNotice, type MaintenanceAnnouncement } from './maintenanceAnnouncements';
import { NotificationsPage } from './NotificationsPage';
import * as api from './api';

vi.mock('./api', async importOriginal => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    getNotifications: vi.fn().mockResolvedValue({
      unread: 1,
      data: [{
        id: 'n1', readAt: null, createdAt: '2026-11-27T00:00:00Z',
        event: { kind: 'INCIDENT_CHANGED', priority: 'MAJOR', title: 'Live incident', body: 'Inspect RADAR-P', createdAt: '2026-11-27T00:00:00Z', device: null },
        deliveries: [{ status: 'DELIVERED', deliveredAt: null, attemptCount: 1 }],
      }],
    }),
    getNotificationPreferences: vi.fn().mockResolvedValue({ data: { inAppEnabled: true, minimumPriority: 'INFORMATION' } }),
  };
});

describe('maintenance audio read model', () => {
  it('keeps an operational warning separate from equipment alarm acknowledgement', () => {
    const notice: MaintenanceAnnouncement = { id: 'maintenance:test', kind: 'UNSAFE_START', level: 'WARNING', message: 'Start rejected', createdAt: '2026-11-27T00:00:00Z', deviceCode: 'RADAR-P', systemCode: 'RADAR', href: '/maintenance/orders/test', simulated: true };
    expect(maintenanceAudioNotice(notice)).toMatchObject({ id: notice.id, level: 'WARNING', operationalNotice: true, acknowledged: false, device: { code: 'RADAR-P', system: { code: 'RADAR' } } });
  });

  it('renders the normal inbox without requesting read-only rows and shows unread state', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client }, createElement(NotificationsPage)));
    expect(await screen.findByText('Live incident')).toBeTruthy();
    expect(screen.getByText('1 unread')).toBeTruthy();
    expect(api.getNotifications).toHaveBeenCalledWith(undefined);
    client.clear();
  });
});
