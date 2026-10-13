// The external-integration ticket contract (ADR-0016, phase A'). This module IS the contract:
// it strict-parses the caller's payload, renames its vocabulary to Anchor's, and serializes the
// reply. It holds no persistence logic — tickets.createTicket does all of that — so every rule
// here is unit-testable without a database.
//
// Why a separate module and route at all: POST /api/v1/tickets is simultaneously the agent UI,
// customer portal, service-catalog and mail-ingest intake path. Its zod schema is non-strict,
// so an unknown field is stripped and the call still returns 201 — a caller can sync for months
// while its due dates go nowhere. That route cannot be made strict without breaking the human
// paths, so the integration gets its own.
import { z } from 'zod';
import { Errors } from '../errors.js';
import { withSystemContext } from '../db/pool.js';
import * as tickets from './tickets.js';
import type { CreateTicketInput } from './tickets.js';
import type { Principal } from '../types.js';

/**
 * Fields the caller sends that Anchor accepts syntactically but cannot apply:
 * - `status` — Anchor owns the lifecycle; status moves only through /transition.
 * (`priority` used to be here. It is now stored verbatim as the caller's OWN ordering in
 * external_priority — never as Anchor's derived priority, which drives SLA and escalation.)
 * - `tenantId` — Anchor has no tenant concept; organizations are the only boundary.
 *
 * These are reported in the response's `ignored[]` rather than refused, because the caller's
 * documented payload always carries them and a 422 would reject every conformant request
 * forever. Reporting them is the middle path between that and the silent drop this module
 * exists to eliminate.
 */
const NOT_APPLIED = ['status', 'tenantId'] as const;

/** Fields refused because Anchor has no model for them yet. Phase D emptied this list: the
 *  backlog attributes it named are now first-class columns. Kept (rather than deleted) because
 *  the refusal path is the contract's promise that an unsupported field is never silently
 *  dropped, and the next deferred field should land here rather than being invented ad hoc. */
const DEFERRED: readonly string[] = [];

/**
 * Sources whose items are work records, not service commitments. A build-backlog story has an
 * estimate, not a deadline: giving it an SLA clock means it breaches, escalates, and lands in
 * the owning organization's SLA reporting as a missed commitment nobody ever made.
 *
 * Exact match, not a prefix or substring test — `backlog-review` would be somebody's real queue.
 */
const NON_OPERATIONAL_SOURCES = new Set(['backlog']);

/** The published contract's severity mapping. Applied server-side here (unlike
 *  POST /api/v1/tickets, which stores severity descriptively and ignores it for priority) so
 *  the caller does not have to compute Anchor's impact/urgency itself. */
export const SEVERITY_TO_IMPACT_URGENCY: Record<string, [number, number]> = {
  critical: [1, 1],
  high: [2, 2],
  medium: [3, 3],
  low: [4, 4],
};

// Every optional field is `.nullable()` as well, deliberately and uniformly. The caller is a
// typed client that serializes its whole DTO, so it sends `"description": null` for a field it
// considers unset — rejecting that while accepting `"tenantId": null` would be an arbitrary
// distinction that 422s the consumer's very first request. A null reads as "unset": it behaves
// exactly like an omitted key, EXCEPT inside the `integration` group, where presence is the
// signal and an explicit null clears the column.
const payloadSchema = z
  .object({
    externalRef: z.string().min(1).max(200),
    organizationId: z.string().uuid(),
    source: z.string().min(1).max(60),
    title: z.string().min(3).max(300),
    description: z.string().max(20_000).nullable().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).nullable().optional(),
    sourceId: z.string().max(200).nullable().optional(),
    owner: z.string().max(200).nullable().optional(),
    controlIds: z.array(z.string().max(60)).max(200).nullable().optional(),
    dueDate: z.string().datetime({ offset: true }).nullable().optional(),
    labels: z.array(z.string().max(60)).max(100).nullable().optional(),
    carbonUrl: z.string().url().max(2000).nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
    // ---- Phase D: backlog / work-item attributes ----
    parentExternalRef: z.string().min(1).max(200).nullable().optional(),
    estimateDays: z.number().nonnegative().max(10_000).nullable().optional(),
    phase: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal('post-mvp')]).nullable().optional(),
    workstream: z.string().max(60).nullable().optional(),
    acceptanceCriteria: z.string().max(4_000).nullable().optional(),
    blockedReason: z.string().max(2_000).nullable().optional(),
    /** The caller's own ordering (P0-P2 for a build backlog), stored verbatim. */
    priority: z.string().max(16).nullable().optional(),
    // Accepted, never applied — see NOT_APPLIED.
    status: z.string().max(40).nullable().optional(),
    tenantId: z.string().max(200).nullable().optional(),
  })
  .strict();

/** Flatten a ZodError into the RFC 7807 `errors[]` shape (ADR-0015). An unrecognised key is
 *  reported under its own name, because "unrecognized_keys" on the body tells an operator that
 *  something was wrong but not which field. */
function zodFieldErrors(err: z.ZodError): Array<{ field: string; message: string }> {
  return err.issues.flatMap((i) =>
    i.code === 'unrecognized_keys'
      ? (i as z.ZodIssue & { keys: string[] }).keys.map((k) => ({ field: k, message: 'unrecognized field' }))
      : [{ field: i.path.join('.') || '(body)', message: i.message }],
  );
}

/**
 * Strict-parse an integration payload into a `CreateTicketInput`.
 *
 * The returned `integration` group carries ONLY the keys the caller actually sent: the upsert
 * path distinguishes an absent key (preserve the stored value) from a present null (clear it),
 * and collapsing them would make a withdrawn due date impossible to express.
 */
export function parseIntegrationTicket(raw: unknown): { input: CreateTicketInput; ignored: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw Errors.validation('body must be a JSON object');
  }
  const src = raw as Record<string, unknown>;

  const deferred = Object.keys(src).filter((k) => (DEFERRED as readonly string[]).includes(k));
  if (deferred.length) {
    throw Errors.validation(
      'backlog fields are not supported yet (phase D)',
      deferred.map((field) => ({ field, message: 'not supported until phase D (backlog import)' })),
    );
  }

  const parsed = payloadSchema.safeParse(src);
  if (!parsed.success) {
    throw Errors.validation('invalid integration ticket payload', zodFieldErrors(parsed.error));
  }
  const b = parsed.data;

  // Only derive impact/urgency when the caller actually said something about severity. A
  // partial re-sync (an owner-only or dueDate-only update, which the presence rule invites)
  // must not reset a critical finding's priority to P3 — and must not leave the row holding
  // severity='critical' next to priority='P3', which no consumer could reconcile. An explicit
  // null IS a statement, and maps to the 3/3 default.
  const severitySent = 'severity' in src;
  const [impact, urgency] = severitySent
    ? SEVERITY_TO_IMPACT_URGENCY[b.severity ?? ''] ?? [3, 3]
    : [undefined, undefined];

  const integration: NonNullable<CreateTicketInput['integration']> = {};
  if (NON_OPERATIONAL_SOURCES.has(b.source)) integration.suppressSla = true;
  if ('dueDate' in src) integration.dueAt = b.dueDate ?? null;
  if ('owner' in src) integration.owner = b.owner ?? null;
  if ('sourceId' in src) integration.sourceId = b.sourceId ?? null;
  if ('controlIds' in src) integration.controlIds = b.controlIds ?? [];
  if ('carbonUrl' in src) integration.url = b.carbonUrl ?? null;
  if ('parentExternalRef' in src) integration.parentExternalRef = b.parentExternalRef ?? null;
  if ('estimateDays' in src) integration.estimateDays = b.estimateDays ?? null;
  if ('phase' in src) integration.workPhase = b.phase == null ? null : String(b.phase);
  if ('workstream' in src) integration.workstream = b.workstream ?? null;
  if ('acceptanceCriteria' in src) integration.acceptanceCriteria = b.acceptanceCriteria ?? null;
  if ('blockedReason' in src) integration.blockedReason = b.blockedReason ?? null;
  if ('priority' in src) integration.externalPriority = b.priority ?? null;

  // `blockedReason` is the signal, not `status`. Anchor owns the lifecycle, so an integration
  // never drives status on an ongoing sync — but at CREATION an item genuinely blocked on an
  // external dependency must not land as `triage`, which would report it as ready to work.
  // Requiring the reason (rather than trusting a status string) means a blocked item always
  // says why, which is the only part a human reading the queue can act on.
  const blocked = typeof b.blockedReason === 'string' && b.blockedReason.trim().length > 0;
  if (!blocked && b.status === 'blocked') {
    throw Errors.validation('a blocked item must say why it is blocked', [
      { field: 'blockedReason', message: 'required when status is "blocked"' },
    ]);
  }

  return {
    ignored: NOT_APPLIED.filter((k) => k in src),
    input: {
      subject: b.title,
      description: b.description ?? undefined,
      organizationId: b.organizationId,
      externalRef: b.externalRef,
      externalSource: b.source,
      severity: b.severity ?? undefined,
      impact,
      urgency,
      tags: b.labels ?? undefined,
      customFields: b.metadata ?? undefined,
      initialStatus: blocked ? 'blocked' : undefined,
      integration,
    },
  };
}

export interface IntegrationTicketResponse {
  ticketId: string;
  ticketKey: string;
  externalRef: string;
  /** Anchor's authoritative status — not whatever the caller sent. */
  status: string;
  /** Anchor's current assignment, or null. Never derived from the caller's `owner`. */
  assignee: string | null;
  /** The CALLER's deadline (external_due_at), deliberately not Anchor's SLA resolution_due_at:
   *  returning the SLA clock under a field the caller reads as "my deadline" would mislead. */
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** True when this call minted the ticket (HTTP 201); false when it matched and updated (200). */
  created: boolean;
  /** Fields accepted syntactically but not applied — see NOT_APPLIED. */
  ignored: string[];
}

function iso(v: unknown): string | null {
  return v ? new Date(v as string | Date).toISOString() : null;
}

/** Project a ticket row onto the integration contract. Keeping this a pure function means the
 *  external shape is pinned by unit tests and the internal column layout stays free to change. */
export function serializeIntegrationTicket(
  row: Record<string, unknown>,
  created: boolean,
  ignored: string[],
  assignee: string | null,
): IntegrationTicketResponse {
  return {
    ticketId: String(row.id),
    ticketKey: String(row.ticket_number),
    externalRef: String(row.external_ref),
    status: String(row.status),
    assignee,
    dueDate: iso(row.external_due_at),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    created,
    ignored,
  };
}

/**
 * Did this error come from losing a race on the external_ref unique index?
 *
 * `createTicket` does SELECT-then-INSERT, so two simultaneous first-syncs of the same item can
 * both miss the SELECT and one loses to ux_tickets_org_external_ref. For an endpoint whose
 * entire purpose is a safe retry, surfacing that as a 500 would be the wrong answer: the
 * loser's retry finds the row and takes the update path, which is the correct idempotent
 * outcome.
 */
export function isExternalRefConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null | undefined;
  return e?.code === '23505' && e?.constraint === 'ux_tickets_org_external_ref';
}

async function assigneeEmail(agentId: unknown): Promise<string | null> {
  if (!agentId) return null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query('SELECT email FROM users WHERE id=$1', [agentId]);
    return (rows[0]?.email as string | undefined) ?? null;
  });
}

/** Parse -> persist -> serialize. The only function the route calls. */
export async function upsertIntegrationTicket(
  actor: Principal,
  raw: unknown,
): Promise<{ created: boolean; body: IntegrationTicketResponse }> {
  const { input, ignored } = parseIntegrationTicket(raw);

  // The route only requires *a* principal, and a browser cookie session satisfies that as
  // readily as an `ak_` key. createTicket forces a customer-plane caller's org to its own and
  // discards input.organizationId before authorize() ever sees it — which would answer 201 for
  // a request to file into a different organization, having quietly filed it somewhere else.
  // The contract's rule is 403 for an out-of-scope organizationId, on every path.
  if (actor.plane === 'customer' && actor.organizationId !== input.organizationId) {
    throw Errors.forbidden('organizationId is outside this principal\'s scope');
  }

  let result;
  try {
    result = await tickets.createTicket(actor, input);
  } catch (err) {
    if (!isExternalRefConflict(err)) throw err;
    // The row exists now; this attempt takes the update path.
    result = await tickets.createTicket(actor, input);
  }

  const { matched, ...row } = result;
  const created = !matched;
  const assignee = await assigneeEmail(row.assigned_agent_id);
  return { created, body: serializeIntegrationTicket(row, created, ignored, assignee) };
}
