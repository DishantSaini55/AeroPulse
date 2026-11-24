import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const noteInput = z.strictObject({
  systemName: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(1000),
});

type Note = z.infer<typeof noteInput> & { id: string; createdAt: string };

// Each app instance owns its own temporary data until Phase 3 adds PostgreSQL.
export function createApp() {
  const app = express();
  const notes = new Map<string, Note>();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/v1/health', (_request, response) => {
    response.json({ status: 'ok', service: 'aeropulse-api' });
  });

  app.get('/api/v1/notes', (_request, response) => {
    response.json({ data: [...notes.values()], simulated: true });
  });

  app.get('/api/v1/notes/:id', (request, response) => {
    const note = notes.get(String(request.params.id));
    if (!note) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Note not found' } });
      return;
    }
    response.json({ data: note, simulated: true });
  });

  app.post('/api/v1/notes', (request, response) => {
    const parsed = noteInput.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid note',
          details: parsed.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })),
        },
      });
      return;
    }

    const note: Note = { id: randomUUID(), ...parsed.data, createdAt: new Date().toISOString() };
    notes.set(note.id, note);
    response.status(201).location(`/api/v1/notes/${note.id}`).json({ data: note, simulated: true });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
      return;
    }
    console.error('Unhandled API error', error);
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  };
  app.use(errorHandler);

  return app;
}
