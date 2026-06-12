import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal } from './context.js';
import { ApiError, Errors } from '../errors.js';
import { config } from '../config.js';
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import * as accounts from '../modules/accounts.js';
import * as tickets from '../modules/tickets.js';
import * as posture from '../modules/posture.js';
import * as analytics from '../modules/analytics.js';
import * as catalog from '../modules/catalog.js';
import * as conmon from '../modules/conmon.js';
import * as oncall from '../modules/oncall.js';
import * as automation from '../modules/automation.js';
import * as compliance from '../modules/compliance.js';
import * as elevation from '../modules/elevation.js';
import * as attachments from '../modules/attachments.js';
import * as kb from '../modules/kb.js';
import * as links from '../modules/links.js';
import * as changes from '../modules/changes.js';
import * as problems from '../modules/problems.js';
import * as csat from '../modules/csat.js';
import * as queues from '../modules/queues.js';
import * as integrations from '../modules/integrations.js';
import * as services from '../modules/services.js';
import * as notifications from '../modules/notifications.js';
import * as alerts from '../modules/alerts.js';
import { computeScore, grade } from '../modules/posture.js';
import { audit, verifyChain, formatExport, type ExportableRow } from '../modules/audit.js';
import { authorize, can } from '../authz/pdp.js';

function setSessionCookie(reply: any, token: string) {
  reply.header(
    'Set-Cookie',
    `nexus_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600${
      config.isProduction ? '; Secure' : ''
    }`,
  );
}

export async function registerRoutes(app: FastifyInstance) {
  // Uniform problem+json error handling (RFC 7807).
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.status).type('application/problem+json').send({
        type: 'about:blank',
        title: err.title,
        status: err.status,
        detail: err.detail,
        code: err.code,
        correlation_id: req.id,
      });
      return;
    }
    if (err instanceof z.ZodError) {
      reply.status(422).type('application/problem+json').send({
        title: 'Unprocessable Entity',
        status: 422,
        detail: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        correlation_id: req.id,
      });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply.status(500).type('application/problem+json').send({
      title: 'Internal Server Error',
      status: 500,
      correlation_id: req.id,
    });
  });

  app.get('/health', async () => ({ status: 'ok', enclave: config.enclave }));

  // ---------------- Auth / accounts ----------------
  app.post('/api/v1/auth/register', async (req, reply) => {
    const body = z
      .object({
        organizationName: z.string().min(2),
        email: z.string().email(),
        displayName: z.string().optional(),
        password: z.string().min(10),
        cloud: z.enum(['commercial', 'gcc', 'gcchigh', 'azgov']).optional(),
      })
      .parse(req.body);
    const result = await accounts.registerCustomer(body);
    setSessionCookie(reply, result.token);
    reply.status(201);
    return result;
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const result = await accounts.loginLocal(body.email, body.password);
    setSessionCookie(reply, result.token);
    return result;
  });

  app.post('/api/v1/auth/dev-login', async (req, reply) => {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    const result = await accounts.devLogin(body.email);
    setSessionCookie(reply, result.token);
    return result;
  });

  // Lists seeded demo identities for the dev login screen (non-production only).
  app.get('/api/v1/auth/dev-users', async () => {
    if (config.isProduction) throw Errors.forbidden('disabled in production');
    return withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT u.email, u.display_name, u.plane, o.name AS org,
                COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL),'{}') AS roles
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
           LEFT JOIN role_assignments ra ON ra.user_id = u.id
           LEFT JOIN roles r ON r.id = ra.role_id
          WHERE u.password_hash IS NULL OR u.email LIKE '%@nexus.example.com'
          GROUP BY u.email, u.display_name, u.plane, o.name
          ORDER BY u.plane DESC, u.email`,
      );
      return { users: rows };
    });
  });

  app.post('/api/v1/auth/logout', async (_req, reply) => {
    reply.header('Set-Cookie', 'nexus_session=; HttpOnly; Path=/; Max-Age=0');
    return { ok: true };
  });

  app.get('/api/v1/me', async (req) => {
    const p = await requirePrincipal(req);
    return {
      id: p.id,
      plane: p.plane,
      email: p.email,
      organization_id: p.organizationId,
      roles: p.roles,
      capabilities: p.permissions,
      elevated: p.elevated,
    };
  });

  // ---------------- Organizations & users ----------------
  app.get('/api/v1/organizations', async (req) => {
    const p = await requirePrincipal(req);
    if (!can(p, 'org.read') && !can(p, 'customer.admin.manage_users')) throw Errors.forbidden('insufficient permission to list organizations');
    return withOrgContext(orgContextFor(p), async (sql) => {
      const { rows } = await sql.query('SELECT id, name, cloud, status FROM organizations ORDER BY name');
      return { data: rows };
    });
  });

  app.post('/api/v1/organizations/:orgId/users', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    authorize(p, 'customer.admin.manage_users', { organizationId: orgId });
    const body = z
      .object({
        email: z.string().email(),
        displayName: z.string().optional(),
        roleKey: z.string().optional(),
        password: z.string().min(10).optional(),
      })
      .parse(req.body);
    const result = await accounts.provisionUser(p, orgId, body);
    reply.status(201);
    return result;
  });

  app.get('/api/v1/organizations/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return accounts.getOrganization(p, id);
  });

  app.patch('/api/v1/organizations/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ name: z.string().optional(), cloud: z.enum(['commercial', 'gcc', 'gcchigh', 'azgov']).optional(), dataBoundary: z.string().max(100).optional() }).parse(req.body);
    return accounts.updateOrganization(p, id, body);
  });

  app.get('/api/v1/organizations/:id/users', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await accounts.listOrganizationUsers(p, id) };
  });

  // ---------------- Tickets ----------------
  app.post('/api/v1/tickets', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        type: z.string().optional(),
        subject: z.string().min(3).max(300),
        description: z.string().optional(),
        impact: z.number().int().min(1).max(4).optional(),
        urgency: z.number().int().min(1).max(4).optional(),
        category: z.string().optional(),
        serviceId: z.string().uuid().optional(),
        organizationId: z.string().uuid().optional(),
        tags: z.array(z.string()).optional(),
      })
      .parse(req.body);
    const ticket = await tickets.createTicket(p, body);
    reply.status(201);
    return ticket;
  });

  app.get('/api/v1/tickets', async (req) => {
    const p = await requirePrincipal(req);
    const q = z
      .object({
        status: z.string().optional(),
        assignee: z.string().optional(),
        priority: z.string().optional(),
        limit: z.coerce.number().optional(),
        type: z.string().optional(),
      })
      .parse(req.query);
    const data = await tickets.listTickets(p, q);
    return { data, page: { has_more: false, next_cursor: null } };
  });

  app.get('/api/v1/tickets/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return tickets.getTicket(p, id);
  });

  app.post('/api/v1/tickets/:id/comments', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ body: z.string().min(1), visibility: z.enum(['customer', 'internal']).optional() })
      .parse(req.body);
    const comment = await tickets.addComment(p, id, body.body, body.visibility ?? 'customer');
    reply.status(201);
    return comment;
  });

  app.post('/api/v1/tickets/:id/assign', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ assignedAgentId: z.string().uuid().nullable().optional(), assignmentGroupId: z.string().uuid().nullable().optional() })
      .parse(req.body);
    return tickets.assignTicket(p, id, body.assignedAgentId ?? null, body.assignmentGroupId ?? null);
  });

  app.post('/api/v1/tickets/:id/transition', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ to: z.string(), resolutionCode: z.string().optional(), closureNotes: z.string().optional() }).parse(req.body);
    return tickets.transition(p, id, body.to, body);
  });

  // Escalate = reassign ownership to a tier group (single accountable owner).
  app.post('/api/v1/tickets/:id/escalate', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ targetGroup: z.string(), reason: z.string().optional() }).parse(req.body);
    return tickets.escalate(p, id, body.targetGroup, body.reason);
  });

  // Manual SLA pause/resume (auto pause/resume also follows on-hold status transitions).
  app.post('/api/v1/tickets/:id/sla/pause', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return tickets.pauseSla(p, id);
  });

  app.post('/api/v1/tickets/:id/sla/resume', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return tickets.resumeSla(p, id);
  });

  // ---------------- Ticket links & merge ----------------
  app.post('/api/v1/tickets/:id/links', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ toTicketId: z.string().uuid(), linkType: z.string() }).parse(req.body);
    const link = await links.createLink(p, id, body.toTicketId, body.linkType);
    reply.status(201);
    return link;
  });

  app.delete('/api/v1/tickets/:id/links/:linkId', async (req) => {
    const p = await requirePrincipal(req);
    const { linkId } = z.object({ id: z.string().uuid(), linkId: z.string().uuid() }).parse(req.params);
    return links.removeLink(p, linkId);
  });

  app.post('/api/v1/tickets/:id/merge', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ intoTicketId: z.string().uuid() }).parse(req.body);
    return links.merge(p, id, body.intoTicketId);
  });

  // ---------------- Attachments ----------------
  app.post('/api/v1/tickets/:id/attachments', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const file = await (req as any).file();
    if (!file) throw Errors.badRequest('multipart file field required');
    const bytes = await file.toBuffer();
    const att = await attachments.upload(p, {
      ticketId: id,
      filename: file.filename,
      contentType: file.mimetype,
      bytes,
    });
    reply.status(201);
    return att;
  });

  app.get('/api/v1/tickets/:id/attachments', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await attachments.listForTicket(p, id) };
  });

  app.get('/api/v1/attachments/:id', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await attachments.download(p, id);
    reply
      .header('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`)
      .type(result.contentType)
      .send(result.bytes);
  });

  // ---------------- Service catalog & request fulfillment ----------------
  app.get('/api/v1/catalog', async (req) => {
    await requirePrincipal(req);
    return { data: await catalog.listCatalog() };
  });

  app.post('/api/v1/catalog/:key/request', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const body = z.object({ subject: z.string().optional(), description: z.string().optional(), organizationId: z.string().uuid().optional() }).parse(req.body);
    const ticket = await catalog.createRequest(p, key, body);
    reply.status(201);
    return ticket;
  });

  app.post('/api/v1/tickets/:id/tasks/:taskId/complete', async (req) => {
    const p = await requirePrincipal(req);
    const { id, taskId } = z.object({ id: z.string().uuid(), taskId: z.string().uuid() }).parse(req.params);
    const body = z.object({ skip: z.boolean().optional() }).parse(req.body ?? {});
    return catalog.completeTask(p, id, taskId, body.skip ?? false);
  });

  app.post('/api/v1/tickets/:id/approve', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    return catalog.decideApproval(p, id, body.approve);
  });

  // ---------------- ConMon (continuous monitoring) ----------------
  app.get('/api/v1/conmon/runs', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    const orgId = p.plane === 'customer' ? p.organizationId ?? undefined : q.organizationId;
    return { data: await conmon.listRuns(p, orgId) };
  });

  app.post('/api/v1/conmon/run', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    return conmon.run(p, p.plane === 'customer' ? p.organizationId ?? undefined : q.organizationId);
  });

  // ---------------- Posture ----------------
  app.get('/api/v1/posture/score', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    const orgId = p.plane === 'customer' ? p.organizationId! : q.organizationId;
    if (!orgId) throw Errors.badRequest('organizationId required');
    authorize(p, 'posture.read', { organizationId: orgId });
    const score = await computeScore(p, orgId);
    return { overall_score: score, grade: grade(score) };
  });

  app.get('/api/v1/posture/findings', async (req) => {
    const p = await requirePrincipal(req);
    const q = z
      .object({ organizationId: z.string().uuid().optional(), severity: z.string().optional(), status: z.string().optional() })
      .parse(req.query);
    const orgId = p.plane === 'customer' ? p.organizationId! : q.organizationId;
    if (!orgId) throw Errors.badRequest('organizationId required');
    const data = await posture.listFindings(p, orgId, q);
    return { data };
  });

  app.post('/api/v1/posture/findings', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        organizationId: z.string().uuid(),
        title: z.string().min(3),
        domain: z.string(),
        severity: z.enum(['critical', 'high', 'moderate', 'low', 'info']),
      })
      .parse(req.body);
    const finding = await posture.createFinding(p, body);
    reply.status(201);
    return finding;
  });

  app.post('/api/v1/posture/findings/:id/to-ticket', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ticket = await posture.findingToTicket(p, id);
    reply.status(201);
    return ticket;
  });

  // ---------------- Compliance & evidence ----------------
  app.get('/api/v1/compliance/controls', async (req) => {
    await requirePrincipal(req);
    return withSystemContext(async (sql) => {
      const { rows } = await sql.query('SELECT control_id, framework, family, title, description FROM compliance_controls ORDER BY control_id');
      return { data: rows };
    });
  });

  app.get('/api/v1/compliance/coverage', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    const orgId = p.plane === 'customer' ? p.organizationId! : q.organizationId;
    if (!orgId) throw Errors.badRequest('organizationId required');
    return { data: await compliance.controlCoverage(p, orgId) };
  });

  app.post('/api/v1/compliance/evidence-package', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    const orgId = p.plane === 'customer' ? p.organizationId! : q.organizationId;
    if (!orgId) throw Errors.badRequest('organizationId required');
    return compliance.evidencePackage(p, orgId);
  });

  app.post('/api/v1/posture/findings/:id/exception', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        justification: z.string().min(5),
        compensatingControl: z.string().optional(),
        expiresAt: z.string().datetime().optional(),
        organizationId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const ex = await compliance.requestException(p, { findingId: id, ...body });
    reply.status(201);
    return ex;
  });

  app.post('/api/v1/posture/exceptions/:id/decide', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    return compliance.decideException(p, id, body.approve);
  });

  // ---------------- Analytics (IT Helpdesk dashboard) ----------------
  app.get('/api/v1/analytics/overview', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    const orgId = p.plane === 'customer' ? p.organizationId ?? undefined : q.organizationId;
    return analytics.overview(p, orgId);
  });

  // ---------------- On-call / paging ----------------
  app.get('/api/v1/oncall/schedules', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await oncall.listSchedules(p) };
  });

  app.get('/api/v1/oncall/pages', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await oncall.listPages(p) };
  });

  app.get('/api/v1/oncall/responders', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await oncall.listResponders(p) };
  });

  app.post('/api/v1/oncall/schedules', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({ team: z.string().min(2), tz: z.string().optional(), coverage: z.string().optional(), lengthDays: z.number().int().min(1).max(90).optional(), participantIds: z.array(z.string().uuid()).min(1) })
      .parse(req.body);
    const r = await oncall.createSchedule(p, body);
    reply.status(201);
    return r;
  });

  app.patch('/api/v1/oncall/schedules/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ lengthDays: z.number().int().min(1).max(90).optional(), participantIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
    return oncall.updateRotation(p, id, body);
  });

  app.post('/api/v1/oncall/overrides', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({ scheduleId: z.string().uuid(), userId: z.string().uuid(), startsAt: z.string(), endsAt: z.string(), reason: z.string().optional() })
      .parse(req.body);
    const r = await oncall.createOverride(p, body);
    reply.status(201);
    return r;
  });

  app.post('/api/v1/oncall/pages', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({ scheduleId: z.string().uuid().optional(), ticketId: z.string().uuid().optional(), organizationId: z.string().uuid().optional(), severity: z.string().optional() })
      .parse(req.body ?? {});
    const page = await oncall.createPage(p, body);
    reply.status(201);
    return page;
  });

  app.post('/api/v1/oncall/pages/:id/ack', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return oncall.acknowledge(p, id);
  });

  app.post('/api/v1/oncall/pages/:id/escalate', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return oncall.escalatePage(p, id);
  });

  // ---------------- Automation / workflow engine ----------------
  app.get('/api/v1/automations', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await automation.listRules(p) };
  });

  app.post('/api/v1/automations', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z.object({ name: z.string().min(3), definition: z.any(), organizationId: z.string().uuid().optional() }).parse(req.body);
    const rule = await automation.createRule(p, { name: body.name, definition: body.definition, organizationId: body.organizationId });
    reply.status(201);
    return rule;
  });

  app.post('/api/v1/automations/:id/simulate', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ event: z.record(z.any()).optional() }).parse(req.body ?? {});
    return automation.simulate(p, id, body.event ?? {});
  });

  app.post('/api/v1/automations/:id/publish', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return automation.publishRule(p, id);
  });

  app.post('/api/v1/automations/:id/state', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ state: z.enum(['draft', 'disabled']) }).parse(req.body);
    return automation.setState(p, id, body.state);
  });

  app.get('/api/v1/automations/:id/executions', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await automation.listExecutions(p, id) };
  });

  // ---------------- Agent work queues ----------------
  app.get('/api/v1/queues', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await queues.listQueues(p) };
  });

  app.post('/api/v1/queues', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        name: z.string().min(1),
        definition: z.object({
          status: z.union([z.string(), z.array(z.string())]).optional(),
          priority: z.union([z.string(), z.array(z.string())]).optional(),
          unassigned: z.boolean().optional(),
          tag: z.string().optional(),
        }).optional(),
        orderBy: z.enum(['sla', 'priority', 'created']).optional(),
      })
      .parse(req.body);
    const queue = await queues.createQueue(p, body);
    reply.status(201);
    return queue;
  });

  app.get('/api/v1/queues/:id/tickets', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return queues.queueTickets(p, id);
  });

  // ---------------- CSAT satisfaction surveys ----------------
  app.get('/api/v1/csat/pending', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await csat.pending(p) };
  });

  app.get('/api/v1/csat/metrics', async (req) => {
    const p = await requirePrincipal(req);
    return csat.metrics(p);
  });

  app.post('/api/v1/csat/:id/respond', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ score: z.number().int().min(1).max(5), comment: z.string().optional() }).parse(req.body);
    return csat.respond(p, id, body.score, body.comment);
  });

  // ---------------- Problem management ----------------
  app.get('/api/v1/problems', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return { data: await problems.listProblems(p, q) };
  });

  app.get('/api/v1/problems/candidates', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    return { data: await problems.candidates(p, q.organizationId) };
  });

  app.post('/api/v1/problems', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({ title: z.string().min(3), description: z.string().optional(), priority: z.string().optional(), organizationId: z.string().uuid().optional() })
      .parse(req.body);
    const problem = await problems.createProblem(p, body);
    reply.status(201);
    return problem;
  });

  app.get('/api/v1/problems/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return problems.getProblem(p, id);
  });

  app.patch('/api/v1/problems/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ rootCause: z.string().optional(), workaround: z.string().optional(), knownError: z.boolean().optional(), priority: z.string().optional() }).parse(req.body);
    return problems.updateProblem(p, id, body);
  });

  app.post('/api/v1/problems/:id/transition', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ to: z.enum(['investigating', 'known_error', 'resolved', 'closed']) }).parse(req.body);
    return problems.transitionProblem(p, id, body.to);
  });

  app.post('/api/v1/problems/:id/link-incident', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ ticketId: z.string().uuid() }).parse(req.body);
    return problems.linkIncident(p, id, body.ticketId);
  });

  // ---------------- Change management & CAB ----------------
  app.get('/api/v1/changes', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return { data: await changes.listChanges(p, q) };
  });

  app.get('/api/v1/changes/calendar', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ from: z.string(), to: z.string() }).parse(req.query);
    return { data: await changes.calendar(p, q.from, q.to) };
  });

  app.post('/api/v1/changes', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        title: z.string().min(3),
        description: z.string().optional(),
        changeType: z.enum(['standard', 'normal', 'emergency']).optional(),
        risk: z.enum(['low', 'medium', 'high']).optional(),
        ticketId: z.string().uuid().optional(),
        backoutPlan: z.string().optional(),
        organizationId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const change = await changes.createChange(p, body);
    reply.status(201);
    return change;
  });

  app.get('/api/v1/changes/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return changes.getChange(p, id);
  });

  app.post('/api/v1/changes/:id/submit-cab', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ approverIds: z.array(z.string().uuid()).default([]) }).parse(req.body ?? {});
    return changes.submitForCab(p, id, body.approverIds);
  });

  app.post('/api/v1/changes/:id/cab-decision', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ approve: z.boolean(), reason: z.string().optional() }).parse(req.body);
    return changes.cabDecision(p, id, body.approve, body.reason);
  });

  app.post('/api/v1/changes/:id/schedule', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ windowStart: z.string().datetime(), windowEnd: z.string().datetime() }).parse(req.body);
    return changes.scheduleChange(p, id, body.windowStart, body.windowEnd);
  });

  app.post('/api/v1/changes/:id/transition', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ to: z.enum(['implementing', 'review', 'closed']) }).parse(req.body);
    return changes.transitionChange(p, id, body.to);
  });

  // ---------------- Knowledge base (Confluence-style) ----------------
  app.get('/api/v1/kb/spaces', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await kb.listSpaces(p) };
  });

  app.post('/api/v1/kb/spaces', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z.object({ key: z.string().min(1).max(16), name: z.string().min(2), description: z.string().optional() }).parse(req.body);
    const space = await kb.createSpace(p, body);
    reply.status(201);
    return space;
  });

  app.get('/api/v1/kb/spaces/:id/tree', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await kb.spaceTree(p, id) };
  });

  app.post('/api/v1/kb/pages', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        spaceId: z.string().uuid(),
        parentId: z.string().uuid().optional(),
        title: z.string().min(2),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
      })
      .parse(req.body);
    const page = await kb.createPage(p, body);
    reply.status(201);
    return page;
  });

  app.get('/api/v1/kb/pages/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return kb.getPage(p, id);
  });

  app.patch('/api/v1/kb/pages/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ title: z.string().min(2).optional(), body: z.string().optional(), labels: z.array(z.string()).optional() }).parse(req.body);
    return kb.updatePage(p, id, body);
  });

  app.post('/api/v1/kb/pages/:id/transition', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ to: z.enum(['draft', 'published', 'archived']) }).parse(req.body);
    return kb.transitionPage(p, id, body.to);
  });

  app.post('/api/v1/kb/pages/:id/comments', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ body: z.string().min(1) }).parse(req.body);
    const comment = await kb.addComment(p, id, body.body);
    reply.status(201);
    return comment;
  });

  app.get('/api/v1/kb/search', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ q: z.string().optional() }).parse(req.query);
    return { data: await kb.search(p, q.q ?? '') };
  });

  app.post('/api/v1/kb/deflect', async (req) => {
    const p = await requirePrincipal(req);
    const body = z.object({ query: z.string().min(1), deflected: z.boolean().optional() }).parse(req.body);
    const suggestions = await kb.suggest(p, body.query);
    await kb.logDeflection(p, { query: body.query, suggestedPageIds: suggestions.map((s: any) => s.id), deflected: body.deflected ?? false });
    return { suggestions };
  });

  app.get('/api/v1/kb/deflection-metrics', async (req) => {
    const p = await requirePrincipal(req);
    return kb.deflectionMetrics(p);
  });

  // ---------------- JIT elevation & break-glass ----------------
  app.post('/api/v1/elevation/request', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({ permissions: z.array(z.string()).min(1), reason: z.string().min(5), organizationId: z.string().uuid().optional() })
      .parse(req.body);
    const g = await elevation.requestElevation(p, body);
    reply.status(201);
    return g;
  });

  app.post('/api/v1/elevation/:id/approve', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ ttlMinutes: z.number().int().min(5).max(480).optional() }).parse(req.body ?? {});
    return elevation.approveElevation(p, id, body.ttlMinutes);
  });

  app.post('/api/v1/elevation/break-glass', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({ permissions: z.array(z.string()).min(1), reason: z.string().min(5), organizationId: z.string().uuid().optional() })
      .parse(req.body);
    const g = await elevation.breakGlass(p, body);
    reply.status(201);
    return g;
  });

  app.get('/api/v1/elevation', async (req) => {
    const p = await requirePrincipal(req);
    const grants = await elevation.activeGrantsFor(p.id);
    return { data: grants };
  });

  // ---------------- Audit ----------------
  app.get('/api/v1/audit-logs', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'audit.read');
    const q = z.object({ action: z.string().optional(), limit: z.coerce.number().optional() }).parse(req.query);
    return withOrgContext(orgContextFor(p), async (sql) => {
      // Audit read is itself audited (handled by middleware in production); scoped by org for customers.
      const where: string[] = [];
      const params: unknown[] = [];
      if (p.plane === 'customer') {
        params.push(p.organizationId);
        where.push(`organization_id = $${params.length}`);
      }
      if (q.action) {
        params.push(q.action);
        where.push(`action = $${params.length}`);
      }
      const limit = Math.min(q.limit ?? 100, 500);
      const { rows } = await sql.query(
        `SELECT id, actor_id, actor_plane, action, resource_type, resource_id, created_at
           FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY created_at DESC LIMIT ${limit}`,
        params,
      );
      return { data: rows };
    });
  });

  // Streamed SIEM export (NDJSON or CEF). Scoped for customers; nexus sees assigned orgs.
  app.get('/api/v1/audit/export', async (req, reply) => {
    const p = await requirePrincipal(req);
    authorize(p, 'audit.read');
    const q = z
      .object({ format: z.enum(['ndjson', 'cef']).optional(), since: z.string().optional(), limit: z.coerce.number().optional() })
      .parse(req.query);
    const format = q.format ?? 'ndjson';
    const result = await withOrgContext(orgContextFor(p), async (sql) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (p.plane === 'customer') {
        params.push(p.organizationId);
        where.push(`organization_id = $${params.length}`);
      }
      if (q.since) {
        params.push(q.since);
        where.push(`created_at >= $${params.length}`);
      }
      const limit = Math.min(q.limit ?? 1000, 5000);
      const { rows } = await sql.query(
        `SELECT id, actor_id, actor_plane, action, resource_type, resource_id, detail,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                prev_hash, row_hash
           FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY seq ASC LIMIT ${limit}`,
        params,
      );
      return rows as ExportableRow[];
    });
    await audit(p, { action: 'audit.export', detail: { format, count: result.length } });
    reply.type(format === 'cef' ? 'text/plain' : 'application/x-ndjson').send(formatExport(result, format));
  });

  // Integrity check: recompute the hash chain and report the first divergence.
  app.get('/api/v1/audit/verify', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'audit.read');
    if (p.plane !== 'nexus') throw Errors.forbidden('chain verification is a platform operation');
    return withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT actor_id, action, resource_id, detail,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                prev_hash, row_hash
           FROM audit_logs ORDER BY seq ASC`,
      );
      return verifyChain(rows as Parameters<typeof verifyChain>[0]);
    });
  });

  // ---------------- Integrations (M365 GCC) ----------------
  app.get('/api/v1/integrations/m365/health', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'integration.manage'); // nexus platform admins (admin.superuser holds it)
    return integrations.getHealth();
  });

  app.post('/api/v1/integrations/m365/test', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'integration.manage');
    const body = z.object({ sendTo: z.string().email().optional() }).parse(req.body ?? {});
    return integrations.runTest({ sendTo: body.sendTo });
  });

  // ---------------- Services & CMDB ----------------
  app.get('/api/v1/services', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await services.listServices(p) };
  });

  app.post('/api/v1/services', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z.object({ name: z.string().min(1), kind: z.string().optional(), organizationId: z.string().uuid().optional() }).parse(req.body);
    reply.code(201);
    return services.createService(p, body);
  });

  app.get('/api/v1/configuration-items', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await services.listConfigurationItems(p, req.query as any) };
  });

  app.post('/api/v1/configuration-items', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z.object({ name: z.string().min(1), ciClass: z.string().min(1), criticality: z.union([z.string(), z.number()]).optional(), status: z.string().optional(), organizationId: z.string().uuid().optional() }).parse(req.body);
    reply.code(201);
    return services.createConfigurationItem(p, body);
  });

  // ---------------- Notification delivery log ----------------
  app.get('/api/v1/notifications/deliveries', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({
      channel: z.string().optional(),
      status: z.string().optional(),
      eventType: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query);
    return { data: await notifications.listDeliveries(p, q) };
  });

  // ---------------- Alerts ----------------
  app.get('/api/v1/alerts', async (req) => { const p = await requirePrincipal(req); const q = z.object({ state: z.string().optional(), severity: z.string().optional() }).parse(req.query); return { data: await alerts.listAlerts(p, q) }; });
  app.post('/api/v1/alerts', async (req, reply) => { const p = await requirePrincipal(req); const b = z.object({ summary: z.string().min(1), severity: z.enum(['P1','P2','P3','P4']).optional(), source: z.string().optional(), dedupKey: z.string().optional(), details: z.record(z.any()).optional(), organizationId: z.string().uuid().optional() }).parse(req.body); reply.code(201); return alerts.createAlert(p, b); });
  app.post('/api/v1/alerts/:id/ack', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return alerts.acknowledgeAlert(p, id); });
  app.post('/api/v1/alerts/:id/resolve', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return alerts.resolveAlert(p, id); });
  app.post('/api/v1/alerts/:id/escalate', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ toPage: z.boolean().optional(), toTicket: z.boolean().optional() }).parse(req.body ?? {}); return alerts.escalateAlert(p, id, b); });
}
