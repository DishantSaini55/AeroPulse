import { getJson } from './api';
import type { AnnouncementAlarm } from './alarmAudio';

export type MaintenanceAnnouncement = {
  id: string; kind: string; level: 'INFORMATION' | 'WARNING'; message: string; createdAt: string;
  deviceCode: string; systemCode: string; href: string; simulated: true;
};
export const getMaintenanceAnnouncements = () => getJson<{ data: MaintenanceAnnouncement[]; truncated: boolean; generatedAt: string; simulated: true }>('/api/v1/maintenance/announcements', false, 25000);

export function maintenanceAudioNotice(notice: MaintenanceAnnouncement): AnnouncementAlarm {
  return { id: notice.id, level: notice.level, message: notice.message, resolvedAt: null, acknowledged: false, operationalNotice: true,
    device: { code: notice.deviceCode, name: notice.deviceCode, system: { code: notice.systemCode, name: notice.systemCode } } };
}
