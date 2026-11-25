import type { RequestHandler } from 'express';
import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';

export function auditMutations(db: Database): RequestHandler {
  return (request, response, next) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) { next(); return; }
    const actor = response.locals.user as PublicUser;
    // Test auth providers may use synthetic IDs; real JWT identities are UUIDs.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor.id)) { next(); return; }
    const path = request.path.slice(0, 300);
    response.once('finish', () => {
      void db.auditEvent.create({ data: { actorId: actor.id, actorRole: actor.role, method: request.method, path, statusCode: response.statusCode } })
        .catch(error => console.error('Audit event write failed', error));
    });
    next();
  };
}
