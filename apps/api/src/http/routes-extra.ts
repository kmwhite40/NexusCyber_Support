// Supplementary route plugin for features added alongside concurrent work, registered
// from server.ts as a second pass so it does not contend with the main routes.ts file.
// Houses: ticket worklogs / time tracking. (Future isolated additions can append here.)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal } from './context.js';
import * as worklogs from '../modules/worklogs.js';

export async function registerExtraRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- Ticket worklogs / time tracking ----------------
  app.post('/api/v1/tickets/:id/worklogs', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ minutes: z.number().int().positive(), note: z.string().optional() }).parse(req.body);
    const log = await worklogs.addWorklog(p, id, body.minutes, body.note);
    reply.status(201);
    return log;
  });

  app.get('/api/v1/tickets/:id/worklogs', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return worklogs.listForTicket(p, id);
  });
}
