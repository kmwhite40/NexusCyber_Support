// Supplementary route plugin for features added alongside concurrent work, registered
// from server.ts as a second pass so it does not contend with the main routes.ts file.
// Houses: ticket worklogs / time tracking. (Future isolated additions can append here.)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal } from './context.js';
import * as worklogs from '../modules/worklogs.js';
import * as automation from '../modules/automation.js';
import * as canned from '../modules/canned.js';

export async function registerExtraRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- Canned responses ----------------
  app.get('/api/v1/canned-responses', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await canned.listCanned(p) };
  });

  app.post('/api/v1/canned-responses', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z.object({ name: z.string().min(1), body: z.string().min(1), tags: z.array(z.string()).optional() }).parse(req.body);
    const c = await canned.createCanned(p, body);
    reply.status(201);
    return c;
  });

  app.get('/api/v1/canned-responses/:id/render', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ ticketId: z.string().uuid() }).parse(req.query);
    return canned.render(p, id, q.ticketId);
  });

  // ---------------- Automation gated-action approvals ----------------
  app.get('/api/v1/automations/pending-approvals', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await automation.listPendingApprovals(p) };
  });

  app.post('/api/v1/automations/executions/:id/approve', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return automation.approveExecution(p, id);
  });

  app.post('/api/v1/automations/executions/:id/reject', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return automation.rejectExecution(p, id);
  });

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
