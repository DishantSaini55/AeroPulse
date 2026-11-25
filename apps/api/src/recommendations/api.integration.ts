import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { createDb } from '../db.js';
import type { AuthProvider } from '../auth.js';

const db = createDb();
let server: Server | undefined;
const createdFaultIds: string[] = [];
let decisionId: string | undefined;
try {
  const user = await db.user.findFirst({ where: { role: 'ADMINISTRATOR', active: true }, select: { id: true, email: true, name: true } });
  const device = await db.device.findFirst({ select: { id: true, code: true } });
  assert.ok(user && device, 'Seeded administrator and device required');
  const cause = `integration connector ${randomUUID()}`;
  async function createFault() {
    const now = new Date();
    const record = await db.faultDiagnosis.create({ data: { deviceId: device!.id, ruleCode: 'INTEGRATION_RECOMMENDATION', suspectedCause: cause, confirmedRootCause: cause,
      component: 'Network interface', severity: 'WARNING', symptoms: ['test fixture'], supportingTelemetry: {}, serviceImpact: 'none', investigationSteps: ['review fixture'], recoveryAction: 'none',
      detectedAt: new Date(now.getTime() - 60_000), firstObservedAt: new Date(now.getTime() - 61_000), lastSeenAt: now, resolvedAt: now, simulated: true } });
    createdFaultIds.push(record.id);
  }
  await createFault();
  const auth: AuthProvider = { login: async () => null, verifyToken: async token => ['supervisor', 'engineer'].includes(token) ? {
    id: user.id, email: user.email, name: user.name, role: token === 'supervisor' ? 'SUPERVISOR' : 'MAINTENANCE_ENGINEER', active: true,
  } : null };
  server = createApp(db, undefined, auth).listen(0);
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/recommendations`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { authorization: 'Bearer supervisor' };
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  const report = await response.json() as { data: { deviceId: string; rootCause: string; causeKey: string; evidenceHash: string; action: string; decision: null | { decision: string } }[] };
  const row = report.data.find(item => item.rootCause === cause);
  assert.ok(row);
  assert.equal(row.action, 'CONTINUE_MONITORING');
  const body = { deviceId: row.deviceId, causeKey: row.causeKey, evidenceHash: row.evidenceHash, decision: 'APPROVED', note: 'Fixture evidence reviewed' };
  const options = (token: string, payload: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await fetch(`${url}/decisions`, options('engineer', body))).status, 403);
  assert.equal((await fetch(`${url}/decisions`, options('supervisor', { ...body, note: '' }))).status, 400);
  const saved = await fetch(`${url}/decisions`, options('supervisor', body));
  assert.equal(saved.status, 201);
  decisionId = ((await saved.json()) as { data: { id: string } }).data.id;
  assert.equal((await fetch(`${url}/decisions`, options('supervisor', body))).status, 409);
  const reviewed = await (await fetch(url, { headers })).json() as typeof report;
  assert.equal(reviewed.data.find(item => item.rootCause === cause)?.decision?.decision, 'APPROVED');
  await createFault();
  assert.equal((await fetch(`${url}/decisions`, options('supervisor', body))).status, 409);
  console.log('Recommendation API authorization, validation, approval, duplicate and stale-evidence checks passed');
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  if (decisionId) await db.recommendationDecision.delete({ where: { id: decisionId } });
  if (createdFaultIds.length) await db.faultDiagnosis.deleteMany({ where: { id: { in: createdFaultIds } } });
  await db.$disconnect();
}
