import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { createDb } from '../db.js';
import type { AuthProvider } from '../auth.js';

const db = createDb();
let server: Server | undefined;
const auditIds: string[] = [];
try {
  const user = await db.user.findFirst({ where: { role: 'ADMINISTRATOR', active: true }, select: { id: true, name: true, email: true } });
  assert.ok(user, 'Seeded administrator required');
  const now = new Date();
  const fixtureAuditId = randomUUID();
  auditIds.push(fixtureAuditId);
  await db.auditEvent.create({ data: { id: fixtureAuditId, actorId: user.id, actorRole: 'ADMINISTRATOR', method: 'POST', path: '/api/v1/test-audit', statusCode: 201, occurredAt: now } });
  const auth: AuthProvider = { login: async () => null, verifyToken: async token => token === 'supervisor' ? { id: user.id, name: user.name, email: user.email, role: 'SUPERVISOR', active: true } : token === 'administrator' ? { id: user.id, name: user.name, email: user.email, role: 'ADMINISTRATOR', active: true } : token === 'engineer' ? { id: user.id, name: user.name, email: user.email, role: 'MAINTENANCE_ENGINEER', active: true } : null };
  server = createApp(db, undefined, auth).listen(0);
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const headers = { authorization: 'Bearer supervisor' };
  const today = now.toISOString().slice(0, 10);
  const note = await fetch(`${base}/notes`, { method: 'POST', headers: { authorization: 'Bearer administrator', 'content-type': 'application/json' }, body: JSON.stringify({ systemName: 'TEST', message: 'Audit middleware verification' }) });
  assert.equal(note.status, 201);
  let mutationAudit: { id: string } | null = null;
  for (let attempt = 0; attempt < 20 && !mutationAudit; attempt++) {
    mutationAudit = await db.auditEvent.findFirst({ where: { actorId: user.id, method: 'POST', path: '/notes', statusCode: 201 }, select: { id: true }, orderBy: { occurredAt: 'desc' } });
    if (!mutationAudit) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(mutationAudit, 'Successful mutation should create an audit event');
  auditIds.push(mutationAudit.id);
  const reportUrl = `${base}/reports?type=incidents&from=${today}&to=${today}`;
  assert.equal((await fetch(reportUrl)).status, 401);
  assert.equal((await fetch(reportUrl, { headers: { authorization: 'Bearer engineer' } })).status, 403);
  const json = await fetch(reportUrl, { headers });
  assert.equal(json.status, 200);
  const report = await json.json() as { type: string; columns: string[]; rows: unknown[]; total: number; note: string };
  assert.equal(report.type, 'incidents');
  assert.equal(report.rows.length, report.total);
  assert.ok(report.columns.includes('incidentId'));
  assert.match(report.note, /UTC/i);
  const csv = await fetch(`${reportUrl}&format=csv`, { headers });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/i);
  assert.match(await csv.text(), /incidentId/);
  for (const type of ['repairs', 'replacements', 'failovers', 'audit']) {
    const response = await fetch(`${base}/reports?type=${type}&from=${today}&to=${today}`, { headers });
    assert.equal(response.status, 200, `${type} report should be available`);
  }
  assert.equal((await fetch(`${base}/reports?type=audit&from=${today}&to=${today}&device=ILS-P`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/reports?type=repairs&from=${today}&to=2024-01-01`, { headers })).status, 400);
  const audit = await fetch(`${base}/audit-events?from=${today}&to=${today}&outcome=success`, { headers });
  assert.equal(audit.status, 200);
  const auditBody = await audit.json() as { data: { id: string; statusCode: number }[]; total: number };
  assert.ok(auditBody.data.some(item => item.id === fixtureAuditId && item.statusCode === 201));
  assert.equal((await fetch(`${base}/audit-events?outcome=broken`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/audit-events`, { headers: { authorization: 'Bearer engineer' } })).status, 403);
  console.log('Report JSON/CSV, filter validation and audit authorization/pagination verified');
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  if (auditIds.length) await db.auditEvent.deleteMany({ where: { id: { in: auditIds } } }).catch(() => undefined);
  await db.$disconnect();
}
