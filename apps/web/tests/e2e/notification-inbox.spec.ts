import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('unauthenticated operator sees the sign-in screen', async ({ page }) => {
  await page.goto('/notifications', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notification inbox' })).not.toBeVisible();
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
});

test('capture responsive operations views for visual inspection', async ({ page }) => {
  test.setTimeout(150_000);
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('requestfailed', request => browserErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
  const user = { id: 'visual-test', email: 'visual@example.test', name: 'Visual Administrator', role: 'ADMINISTRATOR', active: true };
  await page.addInitScript(() => sessionStorage.setItem('aeropulse-token', 'visual-test-token'));
  await page.route('**/socket.io/**', route => route.abort());
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const payload = url.pathname === '/api/v1/auth/me'
      ? { user }
      : url.pathname === '/api/v1/weather/vidp'
        ? { data: null, stale: true, source: 'AVIATION_WEATHER_CENTER' }
        : url.pathname === '/api/v1/notifications'
          ? { data: [], unread: 0 }
          : url.pathname === '/api/v1/notification-preferences'
            ? { data: { inAppEnabled: true, minimumPriority: 'INFORMATION' } }
            : url.pathname === '/api/v1/alarms'
              ? { data: [] }
              : { message: 'Visual review data is intentionally unavailable.' };
    const available = ['/api/v1/auth/me', '/api/v1/weather/vidp', '/api/v1/notifications', '/api/v1/notification-preferences', '/api/v1/alarms'].includes(url.pathname);
    await route.fulfill({ status: available ? 200 : 503, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  const evidence = resolve('../../docs/prompt-9-browser-review');
  await mkdir(evidence, { recursive: true });
  const pages = [
    ['/', 'Infrastructure overview'], ['/infrastructure', 'Infrastructure monitoring'], ['/redundancy', 'Heartbeat & redundancy'],
    ['/diagnostics', 'Fault diagnostics'], ['/alarms', 'Alarm center'], ['/notifications', 'Notification inbox'],
    ['/incidents', 'Incidents'], ['/maintenance', 'Maintenance overview'], ['/analytics', 'Reliability analytics'],
    ['/recommendations', 'Replacement recommendations'], ['/reports', 'Infrastructure reports'], ['/event-history', 'Audit activity'],
    ['/weather', 'Aviation weather'], ['/users', 'User management'], ['/simulation', 'Simulation laboratory'],
  ] as const;
  for (const [route, heading] of pages) {
    const slug = route === '/' ? 'overview' : route.slice(1).replaceAll('/', '-');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    try { await expect(page.getByText(heading, { exact: true }).first()).toBeVisible({ timeout: 30_000 }); }
    catch (error) { throw new Error(`${String(error)}\nBrowser errors: ${browserErrors.join('\n')}`); }
    try { await expect(page.locator('main').getByText(/\b(?:Loading|Calculating)\b/i)).toHaveCount(0, { timeout: 25_000 }); }
    catch { throw new Error(`${route} remained in a loading state. Main content: ${await page.locator('main').innerText()}\nBrowser errors: ${browserErrors.join('\n')}`); }
    await page.screenshot({ path: resolve(evidence, `${slug}-desktop.png`), animations: 'disabled', timeout: 20_000 });
    await page.setViewportSize({ width: 393, height: 852 });
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Aviation weather' }).focus();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Aviation weather' })).toBeInViewport();
    await page.screenshot({ path: resolve(evidence, `${slug}-mobile.png`), animations: 'disabled', timeout: 20_000 });
  }
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
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(page.getByRole('heading', { name: 'Notification inbox' })).toBeVisible();
  await expect(page.getByText('0 unread')).toBeVisible();
});
