import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { PublicUser } from './auth.js';

export function securityHeaders(): RequestHandler {
  return (_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-DNS-Prefetch-Control', 'off');
    response.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
    next();
  };
}

export function requestLogger(enabled = process.env.LOG_FORMAT === 'json'): RequestHandler {
  return (request, response, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    response.setHeader('X-Request-Id', requestId);
    response.once('finish', () => {
      if (!enabled) return;
      const actor = response.locals.user as PublicUser | undefined;
      console.info(JSON.stringify({ level: 'info', event: 'http_request', requestId, method: request.method, path: request.path,
        statusCode: response.statusCode, durationMs: Math.round(performance.now() - startedAt), actorId: actor?.id, actorRole: actor?.role }));
    });
    next();
  };
}
