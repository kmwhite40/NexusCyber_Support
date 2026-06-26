// Outbound webhook dispatcher (docs/nexus/09 §U, ADR-005). Subscribes to ticket.* domain
// events and POSTs HMAC-signed payloads to per-organization registered endpoints — the
// inbound half of the Anchor two-way sync (status writeback). Deliveries are recorded and
// retried with backoff. Management (CRUD) runs in the caller's RLS org-context; the
// dispatcher runs out-of-band on the event bus and scopes every query by organization_id.
import { createHmac, randomBytes } from 'node:crypto';
import { withOrgContext, withSystemContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { subscribe, type DomainEvent } from '../events/bus.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

// Ticket lifecycle events forwarded to subscribers. (commented/assigned included so a
// receiver can mirror the full conversation, not just status.)
export const WEBHOOK_EVENTS = [
  'ticket.created',
  'ticket.status_changed',
  'ticket.resolved',
  'ticket.closed',
  'ticket.reopened',
  'ticket.assigned',
  'ticket.escalated',
  'ticket.commented',
] as const;

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 8_000;

/** HMAC-SHA256 over the exact request body, hex, prefixed `sha256=` (GitHub-style). */
export function signWebhook(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function ipv4Blocked(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((o) => o > 255)) return true;
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private / this-host
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * SSRF guard for a registered endpoint URL. Blocks loopback/private/link-local literals and
 * obvious metadata hosts; requires https in production. DNS rebinding is out of scope (an
 * egress allow-list at the boundary is the backstop in the gov enclave).
 */
export function isSafeWebhookUrl(raw: string, opts: { allowHttp?: boolean } = {}): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const allowHttp = opts.allowHttp ?? !config.isProduction;
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === 'metadata.google.internal') return false;
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  if (ipv4Blocked(host)) return false;
  return true;
}

// ---------------- Management ----------------

function resolveOrgId(actor: Principal, organizationId?: string): string {
  const orgId = actor.plane === 'customer' ? actor.organizationId : organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  return orgId;
}

function validateEventTypes(types?: string[]): string[] {
  if (!types?.length) return [];
  const allowed = new Set<string>(WEBHOOK_EVENTS);
  const bad = types.filter((t) => !allowed.has(t));
  if (bad.length) throw Errors.badRequest(`unknown event types: ${bad.join(', ')}`);
  return [...new Set(types)];
}

export interface CreateEndpointInput {
  organizationId?: string;
  url: string;
  eventTypes?: string[];
  secret?: string;
}

export async function createEndpoint(actor: Principal, input: CreateEndpointInput) {
  const orgId = resolveOrgId(actor, input.organizationId);
  authorize(actor, 'integration.manage', { organizationId: orgId });
  if (!isSafeWebhookUrl(input.url)) throw Errors.badRequest('url must be a public https endpoint');
  const eventTypes = validateEventTypes(input.eventTypes);
  const secret = input.secret?.trim() || randomBytes(24).toString('hex');

  const row = await withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO webhook_endpoints (organization_id, url, secret, event_types, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, organization_id, url, event_types, active, created_at`,
      [orgId, input.url, secret, eventTypes, actor.id],
    );
    return rows[0];
  });
  await audit(actor, {
    action: 'integration.webhook.create',
    organizationId: orgId,
    resourceType: 'webhook_endpoint',
    resourceId: row.id,
    detail: { url: input.url, eventTypes },
  });
  // `secret` is shown ONCE — the receiver uses it to verify X-Anchor-Signature.
  return { ...row, secret };
}

export async function listEndpoints(actor: Principal, organizationId?: string) {
  const orgId = resolveOrgId(actor, organizationId);
  authorize(actor, 'integration.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, organization_id, url, event_types, active, created_at, updated_at
         FROM webhook_endpoints WHERE organization_id = $1 ORDER BY created_at DESC`,
      [orgId],
    );
    return rows;
  });
}

export async function deleteEndpoint(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const existing = (await sql.query('SELECT organization_id FROM webhook_endpoints WHERE id = $1', [id])).rows[0];
    if (!existing) throw Errors.notFound('webhook endpoint not found');
    authorize(actor, 'integration.manage', { organizationId: existing.organization_id });
    await sql.query('DELETE FROM webhook_endpoints WHERE id = $1', [id]);
    await audit(actor, {
      action: 'integration.webhook.delete',
      organizationId: existing.organization_id,
      resourceType: 'webhook_endpoint',
      resourceId: id,
    });
    return { id, deleted: true };
  });
}

export async function listDeliveries(actor: Principal, organizationId?: string, limit = 50) {
  const orgId = resolveOrgId(actor, organizationId);
  authorize(actor, 'integration.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, endpoint_id, event_id, event_type, status, attempts, response_status, last_error, created_at, delivered_at
         FROM webhook_deliveries WHERE organization_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [orgId, Math.min(limit, 200)],
    );
    return rows;
  });
}

// ---------------- Dispatch (event bus) ----------------

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

async function activeEndpointsFor(sql: Sql, orgId: string, eventType: string): Promise<EndpointRow[]> {
  const { rows } = await sql.query(
    `SELECT id, url, secret FROM webhook_endpoints
      WHERE active AND organization_id = $1
        AND (cardinality(event_types) = 0 OR $2 = ANY(event_types))`,
    [orgId, eventType],
  );
  return rows;
}

/** Enrich a ticket event with a stable snapshot the receiver can map back to its own item. */
async function ticketSnapshot(sql: Sql, ticketId: string | undefined) {
  if (!ticketId) return {};
  const { rows } = await sql.query(
    `SELECT id, ticket_number, status, priority, subject, external_ref, external_source
       FROM tickets WHERE id = $1`,
    [ticketId],
  );
  return rows[0] ?? {};
}

async function postWithRetry(url: string, body: string, headers: Record<string, string>) {
  let attempt = 0;
  let responseStatus: number | undefined;
  let lastError: string | undefined;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
        responseStatus = res.status;
        if (res.ok) return { ok: true, attempt, responseStatus, lastError: undefined };
        lastError = `HTTP ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1))); // 250ms, 500ms backoff
    }
  }
  return { ok: false, attempt, responseStatus, lastError };
}

async function dispatch(evt: DomainEvent): Promise<void> {
  const orgId = evt.organization_id;
  if (!orgId) return;
  await withSystemContext(async (sql) => {
    const endpoints = await activeEndpointsFor(sql, orgId, evt.type);
    if (!endpoints.length) return;
    const ticketId = (evt.data as { ticket_id?: string }).ticket_id;
    const ticket = await ticketSnapshot(sql, ticketId);
    const payload = JSON.stringify({
      event_id: evt.event_id,
      type: evt.type,
      occurred_at: evt.occurred_at,
      organization_id: orgId,
      ticket,
      data: evt.data,
    });

    for (const ep of endpoints) {
      const delivery = (
        await sql.query(
          `INSERT INTO webhook_deliveries (organization_id, endpoint_id, event_id, event_type, status)
           VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
          [orgId, ep.id, evt.event_id, evt.type],
        )
      ).rows[0];

      const result = await postWithRetry(ep.url, payload, {
        'content-type': 'application/json',
        'x-anchor-event': evt.type,
        'x-anchor-delivery': delivery.id,
        'x-anchor-signature': signWebhook(ep.secret, payload),
      });

      await sql.query(
        `UPDATE webhook_deliveries
            SET status = $2, attempts = $3, response_status = $4, last_error = $5,
                delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE NULL END
          WHERE id = $1`,
        [delivery.id, result.ok ? 'delivered' : 'failed', result.attempt, result.responseStatus ?? null, result.lastError ?? null],
      );
      if (!result.ok) {
        logger.warn({ endpoint: ep.id, type: evt.type, error: result.lastError }, 'webhook delivery failed');
      }
    }
  });
}

/** Wire the dispatcher to ticket.* events. Called once at startup from server.ts. */
export function registerWebhookHandlers(): void {
  for (const type of WEBHOOK_EVENTS) {
    subscribe(type, (evt) => {
      dispatch(evt).catch((err) => logger.error({ err, type }, 'webhook dispatch error (would DLQ)'));
    });
  }
}
