import { describe, expect, it } from 'vitest';
import { maintenanceAudioNotice, type MaintenanceAnnouncement } from './maintenanceAnnouncements';

describe('maintenance audio read model', () => {
  it('keeps an operational warning separate from equipment alarm acknowledgement', () => {
    const notice: MaintenanceAnnouncement = { id: 'maintenance:test', kind: 'UNSAFE_START', level: 'WARNING', message: 'Start rejected', createdAt: '2026-11-27T00:00:00Z', deviceCode: 'RADAR-P', systemCode: 'RADAR', href: '/maintenance/orders/test', simulated: true };
    expect(maintenanceAudioNotice(notice)).toMatchObject({ id: notice.id, level: 'WARNING', operationalNotice: true, acknowledged: false, device: { code: 'RADAR-P', system: { code: 'RADAR' } } });
  });
});
