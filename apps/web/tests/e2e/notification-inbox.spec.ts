import { test, expect } from '@playwright/test';

test('unauthenticated operator sees the sign-in screen', async ({ page }) => {
  await page.goto('/notifications', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notification inbox' })).not.toBeVisible();
});

test('inbox reads are scoped, mark-read works, and preferences persist', async ({ page }) => {
  const user = { id: 'test-operator', email: 'operator@example.test', name: 'Test Operator', role: 'SUPERVISOR', active: true };
  let read = false;
  let enabled = true;
  await page.addInitScript(() => sessionStorage.setItem('aeropulse-token', 'local-test-token'));
  await page.route('**/socket.io/**', route => route.abort());
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    let body: unknown = { data: [] };
    if (path === '/api/v1/auth/me') body = { user };
    else if (path === '/api/v1/notifications/read-all' && method === 'POST') { read = true; body = { data: { updated: 1 } }; }
    else if (path.endsWith('/read') && method === 'POST') { read = true; body = { data: { id: 'notice-1', readAt: new Date().toISOString() } }; }
    else if (path === '/api/v1/notifications') body = { unread: read ? 0 : 1, data: url.searchParams.get('unread') === 'true' && read ? [] : [{ id: 'notice-1', readAt: read ? new Date().toISOString() : null, createdAt: '2026-11-27T00:00:00Z', event: { kind: 'INCIDENT_CHANGED', priority: 'MAJOR', title: 'Incident assigned', body: 'Check RADAR-P', createdAt: '2026-11-27T00:00:00Z', device: { code: 'RADAR-P', name: 'Radar primary', system: { code: 'RADAR' } } }, deliveries: [{ status: 'DELIVERED', deliveredAt: '2026-11-27T00:00:00Z', attemptCount: 1 }] }] };
    else if (path === '/api/v1/notification-preferences') { if (method === 'PATCH') enabled = (route.request().postDataJSON() as { inAppEnabled?: boolean }).inAppEnabled ?? enabled; body = { data: { inAppEnabled: enabled, minimumPriority: 'INFORMATION' } }; }
    else if (path === '/api/v1/alarms') body = { data: [] };
    else if (path === '/api/v1/maintenance/announcements') body = { data: [] };
    else if (path === '/api/v1/monitoring/snapshot') body = { data: [], recordedAt: new Date().toISOString(), simulated: true };
    else if (path === '/api/v1/weather/vidp') body = { data: null, stale: true, source: 'AVIATION_WEATHER_CENTER' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/notifications', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Notification inbox' })).toBeVisible();
  await expect(page.getByText('Incident assigned')).toBeVisible();
  await expect(page.getByText('1 unread')).toBeVisible();
  await page.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(page.getByText('0 unread')).toBeVisible();
  await page.getByLabel('Enabled').uncheck();
  await expect(page.getByLabel('Enabled')).not.toBeChecked();
});
