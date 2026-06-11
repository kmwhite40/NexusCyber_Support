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
import { computeScore, grade } from '../modules/posture.js';
import { authorize } from '../authz/pdp.js';

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
    authorize(p, 'customer.admin.manage_users'); // org admins / agents with mgmt scope
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

  // ---------------- Analytics (IT Helpdesk dashboard) ----------------
  app.get('/api/v1/analytics/overview', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    const orgId = p.plane === 'customer' ? p.organizationId ?? undefined : q.organizationId;
    return analytics.overview(p, orgId);
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
}
