// Supplementary route plugin for features added alongside concurrent work, registered
// from server.ts as a second pass so it does not contend with the main routes.ts file.
// Houses: ticket worklogs / time tracking. (Future isolated additions can append here.)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal } from './context.js';
import * as worklogs from '../modules/worklogs.js';
import * as automation from '../modules/automation.js';
import * as canned from '../modules/canned.js';
import * as bulk from '../modules/bulk.js';
import * as participants from '../modules/participants.js';
import * as workflows from '../modules/workflows.js';
import * as forms from '../modules/forms.js';
import * as announcements from '../modules/announcements.js';

export async function registerExtraRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- Portal announcements ----------------
  app.get('/api/v1/announcements', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await announcements.listActive(p) };
  });

  app.get('/api/v1/announcements/all', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await announcements.listAll(p) };
  });

  app.post('/api/v1/announcements', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        title: z.string().min(1),
        body: z.string().min(1),
        severity: z.enum(['info', 'warning', 'critical']).optional(),
        endsAt: z.string().datetime().optional(),
        organizationId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);
    const a = await announcements.createAnnouncement(p, body);
    reply.status(201);
    return a;
  });

  app.delete('/api/v1/announcements/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return announcements.deactivate(p, id);
  });

  // ---------------- Custom request forms ----------------
  app.get('/api/v1/forms', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await forms.listForms(p) };
  });

  app.get('/api/v1/forms/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return forms.getForm(p, id);
  });

  app.post('/api/v1/forms', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z.object({ key: z.string().min(1), name: z.string().min(1), ticketType: z.string().optional() }).parse(req.body);
    const f = await forms.createForm(p, body);
    reply.status(201);
    return f;
  });

  app.post('/api/v1/forms/:id/fields', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        key: z.string().min(1),
        label: z.string().min(1),
        dataType: z.enum(['text', 'textarea', 'number', 'select', 'checkbox', 'date']).optional(),
        required: z.boolean().optional(),
        options: z.array(z.string()).optional(),
        position: z.number().int().optional(),
      })
      .parse(req.body);
    const f = await forms.addField(p, id, body);
    reply.status(201);
    return f;
  });

  app.post('/api/v1/tickets/:id/form-answers', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ formId: z.string().uuid(), answers: z.record(z.any()) }).parse(req.body);
    return forms.submitAnswers(p, id, body.formId, body.answers);
  });

  // ---------------- Configurable ticket workflows ----------------
  app.get('/api/v1/workflows', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await workflows.listWorkflows(p) };
  });

  app.get('/api/v1/workflows/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return workflows.getWorkflow(p, id);
  });

  app.post('/api/v1/workflows', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z.object({ ticketType: z.string().min(1), name: z.string().min(1), organizationId: z.string().uuid().nullable().optional() }).parse(req.body);
    const wf = await workflows.createWorkflow(p, body);
    reply.status(201);
    return wf;
  });

  app.post('/api/v1/workflows/:id/transitions', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ fromStatus: z.string().min(1), toStatus: z.string().min(1) }).parse(req.body);
    const row = await workflows.addTransition(p, id, body.fromStatus, body.toStatus);
    reply.status(201);
    return row;
  });

  app.delete('/api/v1/workflows/:id/transitions', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ fromStatus: z.string().min(1), toStatus: z.string().min(1) }).parse(req.body);
    return workflows.removeTransition(p, id, body.fromStatus, body.toStatus);
  });

  // ---------------- Ticket participants / watchers / @mentions ----------------
  app.get('/api/v1/tickets/:id/participants', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await participants.listForTicket(p, id) };
  });

  app.post('/api/v1/tickets/:id/participants', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ userId: z.string().uuid(), role: z.enum(['watcher', 'collaborator', 'approver']).optional() }).parse(req.body);
    const row = await participants.addParticipant(p, id, body.userId, body.role);
    reply.status(201);
    return row;
  });

  app.delete('/api/v1/tickets/:id/participants/:userId', async (req) => {
    const p = await requirePrincipal(req);
    const { id, userId } = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
    return participants.removeParticipant(p, id, userId);
  });

  app.post('/api/v1/tickets/:id/mentions', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ text: z.string() }).parse(req.body);
    return participants.processMentions(p, id, body.text);
  });

  // ---------------- Bulk ticket actions ----------------
  app.post('/api/v1/tickets/bulk', async (req) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1),
        action: z.enum(['assign', 'transition', 'comment', 'escalate', 'tag']),
        params: z
          .object({
            assignedAgentId: z.string().uuid().nullable().optional(),
            assignmentGroupId: z.string().uuid().nullable().optional(),
            to: z.string().optional(),
            resolutionCode: z.string().optional(),
            body: z.string().optional(),
            visibility: z.enum(['customer', 'internal']).optional(),
            targetGroup: z.string().optional(),
            reason: z.string().optional(),
            tag: z.string().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    return bulk.bulkAction(p, body.ids, body.action, body.params ?? {});
  });

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
