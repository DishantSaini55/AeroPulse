import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';
import { calculateRecommendations, recommendationPolicy } from './policy.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const decisionInput = z.strictObject({ deviceId: z.uuid(), causeKey: hash, evidenceHash: hash, decision: z.enum(['APPROVED', 'DECLINED']), note: z.string().trim().min(3).max(2000) });

async function currentRecommendations(db: Database) {
  const at = new Date();
  const policy = recommendationPolicy();
  const from = new Date(at.getTime() - policy.windowDays * 86_400_000);
  const devices = await db.device.findMany({ select: { id: true, code: true, name: true, commissionedAt: true, system: { select: { code: true } }, replacements: { orderBy: { replacedAt: 'desc' }, take: 1, select: { replacedAt: true, cost: true } } } });
  const [faults, repairs] = await Promise.all([
    db.faultDiagnosis.findMany({ where: { detectedAt: { gte: from, lte: at }, confirmedRootCause: { not: null } }, select: { id: true, deviceId: true, confirmedRootCause: true, component: true, ruleCode: true, detectedAt: true, resolvedAt: true } }),
    db.repairRecord.findMany({ where: { createdAt: { gte: from, lte: at } }, select: { id: true, cost: true, createdAt: true, incident: { select: { deviceId: true } } } }),
  ]);
  const rows = calculateRecommendations({
    devices: devices.map(item => ({ id: item.id, code: item.code, name: item.name, systemCode: item.system.code,
      commissionedAt: item.commissionedAt, latestReplacementAt: item.replacements[0]?.replacedAt ?? null,
      latestReplacementCost: item.replacements[0] ? Number(item.replacements[0].cost) : null })),
    faults: faults.map(item => ({ id: item.id, deviceId: item.deviceId, rootCause: item.confirmedRootCause, component: item.component, ruleCode: item.ruleCode, detectedAt: item.detectedAt, resolvedAt: item.resolvedAt })),
    repairs: repairs.map(item => ({ id: item.id, deviceId: item.incident.deviceId, at: item.createdAt, cost: Number(item.cost) })),
  }, at, policy);
  return { rows, policy, at };
}

export function recommendationRoutes(db: Database) {
  const router = Router();
  router.get('/recommendations', async (_request, response) => {
    const { rows, policy, at } = await currentRecommendations(db);
    const decisions = rows.length ? await db.recommendationDecision.findMany({ where: { deviceId: { in: rows.map(row => row.deviceId) }, evidenceHash: { in: rows.map(row => row.evidenceHash) } }, include: { decidedBy: { select: { name: true } } } }) : [];
    const current = new Map(decisions.map(item => [`${item.deviceId}:${item.causeKey}:${item.evidenceHash}`, item]));
    response.setHeader('Cache-Control', 'no-store');
    response.json({ data: rows.map(row => ({ ...row, decision: current.get(`${row.deviceId}:${row.causeKey}:${row.evidenceHash}`) ?? null })),
      policy, generatedAt: at.toISOString(), simulated: true,
      note: 'Decision support from confirmed simulated faults. Cost projection extrapolates recorded repair spend; it is not a prediction or automatic replacement order.' });
  });

  router.post('/recommendations/decisions', async (request, response) => {
    const user = response.locals.user as PublicUser;
    if (!['ADMINISTRATOR', 'SUPERVISOR'].includes(user.role)) { response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Supervisor approval required' } }); return; }
    const parsed = decisionInput.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid recommendation evidence, decision and note required' } }); return; }
    const input = parsed.data;
    const { rows } = await currentRecommendations(db);
    const row = rows.find(item => item.deviceId === input.deviceId && item.causeKey === input.causeKey && item.evidenceHash === input.evidenceHash);
    if (!row) { response.status(409).json({ error: { code: 'STALE_RECOMMENDATION', message: 'Evidence changed. Refresh recommendations before deciding.' } }); return; }
    try {
      const saved = await db.recommendationDecision.create({ data: { ...input, action: row.action, decidedById: user.id }, include: { decidedBy: { select: { name: true } } } });
      response.status(201).json({ data: saved, simulated: true });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') { response.status(409).json({ error: { code: 'ALREADY_DECIDED', message: 'This evidence has already been reviewed' } }); return; }
      throw error;
    }
  });
  return router;
}
