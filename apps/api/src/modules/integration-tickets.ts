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
import type { CreateTicketInput } from './tickets.js';

/**
 * Fields the caller sends that Anchor accepts syntactically but cannot apply:
 * - `status` — Anchor owns the lifecycle; status moves only through /transition.
 * - `priority` — Anchor DERIVES priority from impact x urgency; there is no P0.
 * - `tenantId` — Anchor has no tenant concept; organizations are the only boundary.
 *
 * These are reported in the response's `ignored[]` rather than refused, because the caller's
 * documented payload always carries them and a 422 would reject every conformant request
 * forever. Reporting them is the middle path between that and the silent drop this module
 * exists to eliminate.
 */
const NOT_APPLIED = ['status', 'priority', 'tenantId'] as const;

/** Phase-D backlog fields. Refused loudly, so a caller is never told that backlog metadata
 *  landed when it did not. */
const DEFERRED = [
  'parentExternalRef',
  'estimateDays',
  'phase',
  'workstream',
  'acceptanceCriteria',
  'blockedReason',
] as const;

/** The published contract's severity mapping. Applied server-side here (unlike
 *  POST /api/v1/tickets, which stores severity descriptively and ignores it for priority) so
 *  the caller does not have to compute Anchor's impact/urgency itself. */
export const SEVERITY_TO_IMPACT_URGENCY: Record<string, [number, number]> = {
  critical: [1, 1],
  high: [2, 2],
  medium: [3, 3],
  low: [4, 4],
};

const payloadSchema = z
  .object({
    externalRef: z.string().min(1).max(200),
    organizationId: z.string().uuid(),
    source: z.string().min(1).max(60),
    title: z.string().min(3).max(300),
    description: z.string().max(20_000).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).nullable().optional(),
    sourceId: z.string().max(200).nullable().optional(),
    owner: z.string().max(200).nullable().optional(),
    controlIds: z.array(z.string().max(60)).max(200).optional(),
    dueDate: z.string().datetime({ offset: true }).nullable().optional(),
    labels: z.array(z.string().max(60)).max(100).optional(),
    carbonUrl: z.string().url().max(2000).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    // Accepted, never applied — see NOT_APPLIED.
    status: z.string().max(40).optional(),
    priority: z.string().max(8).nullable().optional(),
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

  const [impact, urgency] = SEVERITY_TO_IMPACT_URGENCY[b.severity ?? ''] ?? [3, 3];

  const integration: NonNullable<CreateTicketInput['integration']> = {};
  if ('dueDate' in src) integration.dueAt = b.dueDate ?? null;
  if ('owner' in src) integration.owner = b.owner ?? null;
  if ('sourceId' in src) integration.sourceId = b.sourceId ?? null;
  if ('controlIds' in src) integration.controlIds = b.controlIds ?? [];
  if ('carbonUrl' in src) integration.url = b.carbonUrl ?? null;

  return {
    ignored: NOT_APPLIED.filter((k) => k in src),
    input: {
      subject: b.title,
      description: b.description,
      organizationId: b.organizationId,
      externalRef: b.externalRef,
      externalSource: b.source,
      severity: b.severity ?? undefined,
      impact,
      urgency,
      tags: b.labels,
      customFields: b.metadata,
      integration,
    },
  };
}
