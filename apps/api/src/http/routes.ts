import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { requirePrincipal } from './context.js';
import { ApiError, Errors } from '../errors.js';
import { config } from '../config.js';
import * as oidc from '../auth/oidc.js';
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import * as accounts from '../modules/accounts.js';
import * as platformUsers from '../modules/platform-users.js';
import * as assist from '../modules/assist.js';
import * as tickets from '../modules/tickets.js';
import * as posture from '../modules/posture.js';
import * as analytics from '../modules/analytics.js';
import * as catalog from '../modules/catalog.js';
import * as conmon from '../modules/conmon.js';
import * as oncall from '../modules/oncall.js';
import * as automation from '../modules/automation.js';
import * as compliance from '../modules/compliance.js';
import * as billing from '../modules/billing.js';
import * as elevation from '../modules/elevation.js';
import * as attachments from '../modules/attachments.js';
import * as kb from '../modules/kb.js';
import * as links from '../modules/links.js';
import * as changes from '../modules/changes.js';
import * as cab from '../modules/cab.js';
import * as problems from '../modules/problems.js';
import * as csat from '../modules/csat.js';
import * as queues from '../modules/queues.js';
import * as integrations from '../modules/integrations.js';
import * as services from '../modules/services.js';
import * as notifications from '../modules/notifications.js';
import * as alerts from '../modules/alerts.js';
import * as channels from '../modules/channels.js';
import * as dashboards from '../modules/dashboards.js';
import * as forms from '../modules/forms.js';
import * as sensitiveFields from '../modules/sensitive-fields.js';
import * as escalationPolicies from '../modules/escalation-policies.js';
import * as provisioning from '../modules/provisioning/index.js';
import * as offboarding from '../modules/offboarding/index.js';
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

  // ---------------- Entra OIDC (agent + customer planes) ----------------
  const agentOidcOn = () => config.oidc.enabled && config.oidc.configured;
  const customerOidcOn = () => config.oidcCustomer.enabled && config.oidcCustomer.configured;

  // Public: lets the login UI decide which SSO buttons to show (no rebuild to toggle).
  app.get('/api/v1/auth/config', async () => ({
    oidcEnabled: agentOidcOn(),
    oidcLabel: 'Sign in as Admin',
    customerOidcEnabled: customerOidcOn(),
    customerOidcLabel: 'Sign in with your organization',
  }));

  // Begin Authorization Code + PKCE. ?mode=customer selects the multitenant customer app;
  // otherwise the single-tenant agent app. state/nonce/verifier/mode ride in a short-lived,
  // signed, HttpOnly cookie (Lax is fine: the callback is a top-level GET).
  app.get('/api/v1/auth/oidc/start', async (req, reply) => {
    const mode = (req.query as { mode?: string })?.mode === 'customer' ? 'customer' : 'agent';
    if (mode === 'customer' ? !customerOidcOn() : !agentOidcOn()) {
      throw Errors.forbidden('OIDC is not configured');
    }
    const state = oidc.randomToken();
    const nonce = oidc.randomToken();
    const { verifier, challenge } = oidc.pkcePair();
    const tx = jwt.sign({ state, nonce, verifier, mode }, config.sessionSigningKey, { expiresIn: 600 });
    reply.header(
      'Set-Cookie',
      `oidc_tx=${tx}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${config.isProduction ? '; Secure' : ''}`,
    );
    const url =
      mode === 'customer'
        ? await oidc.buildCustomerAuthUrl({ state, nonce, challenge })
        : await oidc.buildAuthUrl({ state, nonce, challenge });
    return reply.redirect(url);
  });

  // Exchange the code, validate the token (agent: fixed issuer; customer: per-tenant issuer
  // + tid allow-list), map/JIT-provision, and hand the session token to the cross-origin SPA
  // via the URL fragment.
  app.get('/api/v1/auth/oidc/callback', async (req, reply) => {
    const postLogin = config.oidc.postLoginRedirect || config.oidcCustomer.postLoginRedirect;
    const back = (frag: string) => reply.redirect(`${postLogin}#${frag}`);
    const q = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      })
      .parse(req.query);
    if (q.error) return back('error=' + encodeURIComponent(q.error_description ?? q.error));
    if (!q.code || !q.state) return back('error=' + encodeURIComponent('missing code or state'));

    const m = req.headers.cookie?.match(/(?:^|;\s*)oidc_tx=([^;]+)/);
    if (!m) return back('error=' + encodeURIComponent('missing or expired login transaction'));
    let txp: { state: string; nonce: string; verifier: string; mode?: 'agent' | 'customer' };
    try {
      txp = jwt.verify(m[1], config.sessionSigningKey) as typeof txp;
    } catch {
      return back('error=' + encodeURIComponent('invalid login transaction'));
    }
    if (txp.state !== q.state) return back('error=' + encodeURIComponent('state mismatch'));
    const mode = txp.mode === 'customer' ? 'customer' : 'agent';
    if (mode === 'customer' ? !customerOidcOn() : !agentOidcOn()) {
      return back('error=' + encodeURIComponent('OIDC is not configured'));
    }

    try {
      const result =
        mode === 'customer'
          ? await accounts.loginOrProvisionCustomerOidc(
              await oidc.exchangeAndValidateCustomer(q.code, txp.verifier, txp.nonce),
            )
          : await accounts.loginOrProvisionAgentOidc(
              await oidc.exchangeAndValidate(q.code, txp.verifier, txp.nonce),
            );
      // Clear the tx cookie and (best-effort) set the session cookie; the SPA reads the
      // token from the fragment since web and API are cross-origin.
      reply.header('Set-Cookie', [
        'oidc_tx=; HttpOnly; Path=/; Max-Age=0',
        `nexus_session=${encodeURIComponent(result.token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600${
          config.isProduction ? '; Secure' : ''
        }`,
      ]);
      return back('token=' + encodeURIComponent(result.token));
    } catch (e) {
      const detail = e instanceof ApiError ? e.detail : 'sign-in failed';
      return back('error=' + encodeURIComponent(detail ?? 'sign-in failed'));
    }
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
      assigned_orgs: p.assignedOrgs,
      all_orgs: p.allOrgs,
      elevated: p.elevated,
    };
  });

  // ---------------- Organizations & users ----------------
  app.get('/api/v1/organizations', async (req) => {
    const p = await requirePrincipal(req);
    if (!can(p, 'org.read') && !can(p, 'customer.admin.manage_users')) throw Errors.forbidden('insufficient permission to list organizations');
    // Platform admins (org.manage) see ALL orgs (system context); others are RLS-scoped.
    if (can(p, 'org.manage')) {
      return withSystemContext(async (sql) => {
        const { rows } = await sql.query(
          'SELECT id, name, cloud, status, entra_tenant_id FROM organizations ORDER BY name',
        );
        return { data: rows };
      });
    }
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

  // Admin: create a customer org (optionally onboarding its Entra tenant for customer SSO).
  app.post('/api/v1/organizations', async (req, reply) => {
    const p = await requirePrincipal(req);
    if (!can(p, 'org.manage')) throw Errors.forbidden('insufficient permission to create organizations');
    const body = z
      .object({
        name: z.string().min(2),
        cloud: z.enum(['commercial', 'gcc', 'gcchigh', 'azgov']).optional(),
        entraTenantId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const org = await accounts.createOrganizationAdmin(p, body);
    reply.status(201);
    return org;
  });

  app.get('/api/v1/organizations/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return can(p, 'org.manage') ? accounts.getOrganizationAdmin(id) : accounts.getOrganization(p, id);
  });

  // Admin: delete an organization (refuses if it has users unless ?force=true).
  app.delete('/api/v1/organizations/:id', async (req) => {
    const p = await requirePrincipal(req);
    if (!can(p, 'org.manage')) throw Errors.forbidden('insufficient permission to delete organizations');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { force } = z.object({ force: z.coerce.boolean().optional() }).parse(req.query ?? {});
    return accounts.deleteOrganizationAdmin(p, id, force ?? false);
  });

  app.patch('/api/v1/organizations/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Platform admins can also set the SSO tenant + status (system context).
    if (can(p, 'org.manage')) {
      const body = z
        .object({
          name: z.string().optional(),
          cloud: z.enum(['commercial', 'gcc', 'gcchigh', 'azgov']).optional(),
          entraTenantId: z.string().uuid().nullable().optional(),
          status: z.enum(['active', 'suspended', 'archived']).optional(),
        })
        .parse(req.body);
      return accounts.updateOrganizationAdmin(p, id, body);
    }
    const body = z.object({ name: z.string().optional(), cloud: z.enum(['commercial', 'gcc', 'gcchigh', 'azgov']).optional(), dataBoundary: z.string().max(100).optional() }).parse(req.body);
    return accounts.updateOrganization(p, id, body);
  });

  app.get('/api/v1/organizations/:id/users', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (can(p, 'org.manage')) return { data: await accounts.listOrganizationUsersAdmin(id) };
    return { data: await accounts.listOrganizationUsers(p, id) };
  });

  app.get('/api/v1/users/search', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ q: z.string().optional(), organizationId: z.string().uuid().optional() }).parse(req.query);
    const data = await accounts.searchUsers(p, q.q ?? '', q.organizationId);
    return { data };
  });

  // Admin: update a user's status and/or role within an org.
  app.patch('/api/v1/organizations/:orgId/users/:userId', async (req) => {
    const p = await requirePrincipal(req);
    const { orgId, userId } = z
      .object({ orgId: z.string().uuid(), userId: z.string().uuid() })
      .parse(req.params);
    authorize(p, 'customer.admin.manage_users', { organizationId: orgId });
    const body = z
      .object({ status: z.enum(['active', 'suspended']).optional(), roleKey: z.string().optional() })
      .parse(req.body);
    return accounts.updateOrgUserAdmin(p, orgId, userId, body);
  });

  // Admin: deactivate (remove) a user within an org.
  app.delete('/api/v1/organizations/:orgId/users/:userId', async (req) => {
    const p = await requirePrincipal(req);
    const { orgId, userId } = z
      .object({ orgId: z.string().uuid(), userId: z.string().uuid() })
      .parse(req.params);
    authorize(p, 'customer.admin.manage_users', { organizationId: orgId });
    return accounts.removeOrgUserAdmin(p, orgId, userId);
  });

  // ---------------- Virtual agent / assisted intake ----------------
  app.get('/api/v1/assist', async (req) => {
    const p = await requirePrincipal(req);
    const { q } = z.object({ q: z.string() }).parse(req.query);
    return assist.assist(p, q);
  });

  // ---------------- Platform user administration (nexus staff) ----------------
  const scopeSchema = z.union([
    z.object({ mode: z.literal('all') }),
    z.object({ mode: z.literal('orgs'), orgIds: z.array(z.string().uuid()) }),
  ]);

  app.get('/api/v1/platform/users', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'admin.users.manage');
    return { data: await platformUsers.listPlatformUsers(), assignable_roles: platformUsers.assignableRoles(p) };
  });

  app.post('/api/v1/platform/users', async (req, reply) => {
    const p = await requirePrincipal(req);
    authorize(p, 'admin.users.manage');
    const body = z
      .object({
        email: z.string().email(),
        displayName: z.string().optional(),
        roleKeys: z.array(z.string()).optional(),
        password: z.string().min(10).optional(),
        scope: scopeSchema.optional(),
      })
      .parse(req.body);
    const result = await platformUsers.createPlatformUser(p, body);
    reply.status(201);
    return result;
  });

  app.patch('/api/v1/platform/users/:id', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'admin.users.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        status: z.enum(['active', 'suspended']).optional(),
        displayName: z.string().optional(),
        password: z.string().min(10).optional(),
      })
      .parse(req.body);
    return platformUsers.updatePlatformUser(p, id, body);
  });

  app.put('/api/v1/platform/users/:id/roles', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'admin.users.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { roleKeys } = z.object({ roleKeys: z.array(z.string()) }).parse(req.body);
    return platformUsers.setPlatformUserRoles(p, id, roleKeys);
  });

  app.put('/api/v1/platform/users/:id/scope', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'admin.users.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const scope = scopeSchema.parse(req.body);
    return platformUsers.setPlatformUserScope(p, id, scope);
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
        severity: z.string().max(40).optional(),
        customFields: z.record(z.unknown()).optional(),
        externalRef: z.string().min(1).max(200).optional(),
        externalSource: z.string().min(1).max(60).optional(),
      })
      .parse(req.body);
    const { matched, ...ticket } = await tickets.createTicket(p, body);
    // 200 when an existing ticket was matched by externalRef (idempotent re-sync); 201 on create.
    reply.status(matched ? 200 : 201);
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

  // Audited PII read — readSensitive itself enforces `pii.view` and writes the audit entry.
  app.get('/api/v1/tickets/:id/sensitive', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await sensitiveFields.readSensitive(p, id) };
  });

  // ---------------- Entra account provisioning (onboarding fulfillment) ----------------
  // preview and execute go through the SAME planning path in the service, so the dry run an
  // admin approves here is provably the plan the execute call runs. Both refuse with a clear
  // 400 when the feature is not enabled on this deployment.
  app.post('/api/v1/tickets/:id/provisioning/preview', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await provisioning.preview(p, id) };
  });

  // The body carries the fingerprint of the plan the admin previewed and approved. It is
  // required: the service refuses an execute without one rather than treating silence as
  // consent, and refuses a stale one with 412 rather than executing a plan nobody approved.
  // Parsed as optional here so the refusal comes from the service (one place, one message)
  // instead of splitting into a 422 for "no body" and a 400 for "empty string".
  app.post('/api/v1/tickets/:id/provisioning/execute', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ fingerprint: z.string().optional() }).parse(req.body ?? {});
    return { data: await provisioning.provision(p, id, body.fingerprint) };
  });

  // Run history, plus whether this deployment can provision at all. The flag rides along here
  // rather than on the public /auth/config: this route is already the one call the panel makes
  // on mount, it is already authenticated and already checks provisioning.execute, so the
  // answer costs no extra round trip and adds nothing to the unauthenticated surface.
  app.get('/api/v1/tickets/:id/provisioning', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return {
      data: await provisioning.listRuns(p, id),
      provisioningEnabled: provisioning.isEnabled(),
    };
  });

  // ---------------- Entra account offboarding (departure fulfillment) ----------------
  // preview and schedule go through the SAME planning path in the service, so the dry run an
  // admin approves is provably the plan that gets armed. Nothing here writes to the directory:
  // the scheduled sweeper does that when the clock reaches scheduled_for.
  app.post('/api/v1/tickets/:id/offboarding/preview', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await offboarding.preview(p, id) };
  });

  // The body carries the fingerprint of the plan the admin previewed, plus the instant HR
  // instructed. A stale fingerprint is refused with 412 rather than arming a plan nobody read.
  app.post('/api/v1/tickets/:id/offboarding/schedule', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      fingerprint: z.string(),
      scheduledFor: z.string(),
    }).parse(req.body ?? {});
    return { data: await offboarding.schedule(p, id, body.fingerprint, body.scheduledFor) };
  });

  // Run history plus whether this deployment can offboard at all — same reasoning as the
  // provisioning route: already authenticated, already permission-checked, no extra round trip.
  app.get('/api/v1/tickets/:id/offboarding', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return {
      data: await offboarding.listRuns(p, id),
      offboardingEnabled: provisioning.isEnabled(),
    };
  });

  // Options provider for the onboarding form's cloud_pc_policy field
  // (form_fields.options_source = 'cloudpc_policies'). Empty list when provisioning is off.
  app.get('/api/v1/provisioning/cloud-pc-policies', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await provisioning.listCloudPcPolicies(p) };
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

  app.get('/api/v1/catalog/:key/form', async (req) => {
    const p = await requirePrincipal(req);
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const form = await forms.getFormByCatalogKey(p, key);
    return { form };
  });

  app.post('/api/v1/catalog/:key/request', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const body = z.object({
      subject: z.string().optional(),
      description: z.string().optional(),
      organizationId: z.string().uuid().optional(),
      answers: z.record(z.any()).optional(),
    }).parse(req.body);
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

  // ---------------- Billing (admin-only; per-customer allocation + overage) ----------------
  app.get('/api/v1/billing/settings', async (req) => {
    const p = await requirePrincipal(req);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(req.query);
    return billing.getSettings(p, organizationId);
  });

  app.put('/api/v1/billing/settings', async (req) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        organizationId: z.string().uuid(),
        planName: z.string().min(1).max(80),
        monthlyTicketAllocation: z.number().int().min(0),
        overageFeeCents: z.number().int().min(0),
        currency: z.string().min(3).max(3),
      })
      .parse(req.body);
    return billing.setSettings(p, body.organizationId, {
      plan_name: body.planName,
      monthly_ticket_allocation: body.monthlyTicketAllocation,
      overage_fee_cents: body.overageFeeCents,
      currency: body.currency.toUpperCase(),
    });
  });

  app.get('/api/v1/billing/utilization', async (req) => {
    const p = await requirePrincipal(req);
    const q = z
      .object({
        organizationId: z.string().uuid(),
        year: z.coerce.number().int().min(2000).max(2100),
        month: z.coerce.number().int().min(1).max(12),
      })
      .parse(req.query);
    return billing.utilization(p, q.organizationId, q.year, q.month);
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

  // Self-service report builder: safelisted dimension/measure aggregate over tickets.
  app.get('/api/v1/analytics/report/fields', async (req) => {
    await requirePrincipal(req);
    return analytics.REPORT_FIELDS;
  });
  app.get('/api/v1/analytics/report', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({
      dimension: z.string(),
      measure: z.string(),
      days: z.coerce.number().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      type: z.string().optional(),
      organizationId: z.string().uuid().optional(),
    }).parse(req.query);
    const organizationId = p.plane === 'customer' ? p.organizationId ?? undefined : q.organizationId;
    return analytics.runReport(p, { ...q, organizationId });
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

  // The raiser-facing template list. `cab.listTemplates` is the ADMIN read (cab.manage);
  // this one needs only `change.create`, because a pre-approved standard template is now
  // the only route to a standard change and a raiser has to be able to pick one.
  app.get('/api/v1/changes/templates', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query ?? {});
    return { data: await changes.listChangeTemplates(p, q.organizationId) };
  });

  app.post('/api/v1/changes', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        title: z.string().min(3),
        description: z.string().optional(),
        changeType: z.enum(['standard', 'normal', 'emergency']).optional(),
        risk: z.enum(['low', 'medium', 'high']).optional(),
        impact: z.enum(['low', 'medium', 'high']).optional(),
        likelihood: z.enum(['low', 'medium', 'high']).optional(),
        ticketId: z.string().uuid().optional(),
        implementationPlan: z.string().optional(),
        testPlan: z.string().optional(),
        backoutPlan: z.string().optional(),
        templateId: z.string().uuid().optional(),
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
    const body = z
      .object({
        extraVoterIds: z.array(z.string().uuid()).default([]),
        boardId: z.string().uuid().optional(),
      })
      .parse(req.body ?? {});
    return changes.submitForCab(p, id, body);
  });

  // Replaces the old single-approver POST /changes/:id/cab-decision.
  app.post('/api/v1/changes/:id/vote', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ vote: z.enum(['approve', 'reject', 'abstain']), reason: z.string().optional() })
      .parse(req.body);
    return changes.castVote(p, id, body.vote, body.reason);
  });

  app.post('/api/v1/changes/:id/cancel', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    return changes.cancelChange(p, id, body.reason);
  });

  app.post('/api/v1/changes/:id/pir', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        outcome: z.enum(['successful', 'failed', 'rolled_back', 'partial']),
        notes: z.string().optional(),
      })
      .parse(req.body);
    return changes.recordPir(p, id, body.outcome, body.notes);
  });

  app.get('/api/v1/changes/:id/comments', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await changes.listComments(p, id) };
  });

  app.post('/api/v1/changes/:id/comments', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ body: z.string().min(1) }).parse(req.body);
    const row = await changes.addComment(p, id, body.body);
    reply.status(201);
    return row;
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

  // ---------------- CAB administration (board, blackouts, templates) ----------------
  app.get('/api/v1/cab/board', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query ?? {});
    return { data: await cab.getBoard(p, q.organizationId) };
  });

  app.put('/api/v1/cab/board', async (req) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        organizationId: z.string().uuid().nullish(),
        name: z.string().min(1).optional(),
        chairId: z.string().uuid().nullish(),
        quorum: z.number().int().min(1).optional(),
        threshold: z.enum(['majority', 'two_thirds', 'unanimous']).optional(),
        members: z
          .array(
            z.object({
              userId: z.string().uuid(),
              role: z.enum(['chair', 'member']).optional(),
              weight: z.number().int().min(1).optional(),
            }),
          )
          .optional(),
      })
      .parse(req.body ?? {});
    return { data: await cab.putBoard(p, body) };
  });

  app.get('/api/v1/cab/blackouts', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query ?? {});
    return { data: await cab.listBlackouts(p, q.organizationId) };
  });

  app.post('/api/v1/cab/blackouts', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        organizationId: z.string().uuid().nullish(),
        name: z.string().min(1),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        reason: z.string().optional(),
      })
      .parse(req.body);
    const row = await cab.createBlackout(p, body);
    reply.status(201);
    return row;
  });

  app.delete('/api/v1/cab/blackouts/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return cab.deleteBlackout(p, id);
  });

  app.get('/api/v1/cab/templates', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query ?? {});
    return { data: await cab.listTemplates(p, q.organizationId) };
  });

  app.post('/api/v1/cab/templates', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({
        organizationId: z.string().uuid().nullish(),
        name: z.string().min(1),
        changeType: z.enum(['standard', 'normal', 'emergency']).optional(),
        risk: z.enum(['low', 'medium', 'high']).optional(),
        impact: z.enum(['low', 'medium', 'high']).optional(),
        likelihood: z.enum(['low', 'medium', 'high']).optional(),
        description: z.string().optional(),
        implementationPlan: z.string().optional(),
        testPlan: z.string().optional(),
        backoutPlan: z.string().optional(),
      })
      .parse(req.body);
    const row = await cab.createTemplate(p, body);
    reply.status(201);
    return row;
  });

  app.delete('/api/v1/cab/templates/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return cab.deleteTemplate(p, id);
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

  // "Did this article resolve your issue?" — deflection feedback.
  app.post('/api/v1/kb/pages/:id/feedback', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { resolved } = z.object({ resolved: z.boolean() }).parse(req.body);
    return kb.recordFeedback(p, id, resolved);
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
    const body = z.object({
      name: z.string().min(1),
      ciClass: z.string().min(1),
      criticality: z.union([z.string(), z.number()]).optional(),
      status: z.string().optional(),
      owner: z.string().optional(),
      supportGroup: z.string().optional(),
      attributes: z.record(z.unknown()).optional(),
      organizationId: z.string().uuid().optional(),
    }).parse(req.body);
    reply.code(201);
    return services.createConfigurationItem(p, body);
  });

  app.get('/api/v1/configuration-items/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return services.getConfigurationItem(p, id);
  });

  app.patch('/api/v1/configuration-items/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      criticality: z.union([z.string(), z.number()]).optional(),
      status: z.string().optional(),
      owner: z.string().nullable().optional(),
      supportGroup: z.string().nullable().optional(),
      attributes: z.record(z.unknown()).optional(),
    }).parse(req.body);
    return services.updateConfigurationItem(p, id, body);
  });

  app.post('/api/v1/ci-relationships', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z.object({
      sourceId: z.string().uuid(),
      targetId: z.string().uuid(),
      relType: z.enum(services.CI_REL_TYPES),
    }).parse(req.body);
    reply.code(201);
    return services.addCiRelationship(p, body);
  });

  app.delete('/api/v1/ci-relationships/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return services.removeCiRelationship(p, id);
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

  // ---------------- Channels ----------------
  app.get('/api/v1/channels', async (req) => { const p = await requirePrincipal(req); return { data: await channels.listChannels(p) }; });
  app.post('/api/v1/channels', async (req, reply) => { const p = await requirePrincipal(req); const b = z.object({ type: z.enum(['email','portal','widget']), name: z.string().min(1), config: z.record(z.any()).optional(), enabled: z.boolean().optional(), organizationId: z.string().uuid().optional() }).parse(req.body); reply.code(201); return channels.createChannel(p, b); });
  app.patch('/api/v1/channels/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ name: z.string().optional(), config: z.record(z.any()).optional(), enabled: z.boolean().optional() }).parse(req.body); return channels.updateChannel(p, id, b); });

  // ---------------- Named dashboards ----------------
  app.get('/api/v1/dashboards', async (req) => { const p = await requirePrincipal(req); return { data: await dashboards.listDashboards(p) }; });
  app.post('/api/v1/dashboards', async (req, reply) => { const p = await requirePrincipal(req); const b = z.object({ name: z.string().min(1), layout: z.array(z.object({ type: z.string() })).optional(), organizationId: z.string().uuid().optional() }).parse(req.body); reply.code(201); return dashboards.createDashboard(p, b); });
  app.patch('/api/v1/dashboards/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ name: z.string().optional(), layout: z.array(z.object({ type: z.string() })).optional() }).parse(req.body); return dashboards.updateDashboard(p, id, b); });
  app.delete('/api/v1/dashboards/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return dashboards.deleteDashboard(p, id); });

  // ---------------- Escalation policies ----------------
  app.get('/api/v1/escalation-policies', async (req) => { const p = await requirePrincipal(req); return { data: await escalationPolicies.listPolicies(p) }; });
  app.post('/api/v1/escalation-policies', async (req, reply) => { const p = await requirePrincipal(req); const b = z.object({ name: z.string().min(1), steps: z.array(z.object({ targetType: z.enum(['schedule','user']), targetId: z.string().min(1), delayMinutes: z.number().min(0) })).min(1), organizationId: z.string().uuid().optional() }).parse(req.body); reply.code(201); return escalationPolicies.createPolicy(p, b); });
  app.patch('/api/v1/escalation-policies/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ name: z.string().optional(), steps: z.array(z.object({ targetType: z.enum(['schedule','user']), targetId: z.string().min(1), delayMinutes: z.number().min(0) })).optional() }).parse(req.body); return escalationPolicies.updatePolicy(p, id, b as any); });
  app.delete('/api/v1/escalation-policies/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return escalationPolicies.deletePolicy(p, id); });
  app.get('/api/v1/escalation-policies/:id/resolve', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const { step } = z.object({ step: z.coerce.number().int().min(1) }).parse(req.query); return escalationPolicies.resolveStepTarget(p, id, step); });
}
