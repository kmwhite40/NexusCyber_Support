// PII captured on onboarding requests. Held apart from tickets.custom_fields so it is never
// serialized onto ticket reads, notification payloads, or outbound webhooks. Reads require
// `pii.view` and are individually audited; rows cascade-delete with their ticket.
import { withSystemContext, type Sql } from '../db/pool.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { isFieldVisible, type FormField } from './form-fields.js';
import type { Principal } from '../types.js';

export const MASK = '••••';

/** Split answers into the normal bag and the sensitive bag. Pure. Unknown or
 *  currently-hidden fields are dropped entirely. */
export function splitSensitiveAnswers(
  fields: FormField[],
  answers: Record<string, unknown>,
): { normal: Record<string, unknown>; sensitive: Record<string, unknown> } {
  const normal: Record<string, unknown> = {};
  const sensitive: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f.key in answers)) continue;
    if (!isFieldVisible(f, answers)) continue;
    (f.sensitive ? sensitive : normal)[f.key] = answers[f.key];
  }
  return { normal, sensitive };
}

/** Persist sensitive answers on an ALREADY-OPEN connection/transaction. Required when the
 *  ticket itself was inserted in that same transaction and is not yet committed: a second
 *  connection's foreign-key check would block on the uncommitted parent row while that
 *  transaction waits on us. Empty/null/blank values are dropped, never stored. */
export async function storeSensitiveWith(
  sql: Sql,
  ticketId: string,
  organizationId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return;
  for (const [key, value] of entries) {
    await sql.query(
      `INSERT INTO ticket_sensitive_fields (ticket_id, organization_id, key, value)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (ticket_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ticketId, organizationId, key, String(value)],
    );
  }
}

/** Persist sensitive answers for an existing (committed) ticket. System context — called
 *  from fulfillment paths, not a user-facing read route. */
export async function storeSensitive(
  ticketId: string,
  organizationId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return;
  await withSystemContext(async (sql) => {
    await storeSensitiveWith(sql, ticketId, organizationId, values);
  });
}

/** Read PII for a ticket. Requires `pii.view`; every access is audited. */
export async function readSensitive(actor: Principal, ticketId: string): Promise<Record<string, string>> {
  const row = await withSystemContext(async (sql) => {
    const { rows } = await sql.query('SELECT organization_id FROM tickets WHERE id = $1', [ticketId]);
    return rows[0];
  });
  if (!row) return {};
  authorize(actor, 'pii.view', { organizationId: row.organization_id });

  const out = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT key, value FROM ticket_sensitive_fields WHERE ticket_id = $1 ORDER BY key',
      [ticketId],
    );
    return Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  });

  await audit(actor, {
    action: 'pii.viewed',
    organizationId: row.organization_id,
    resourceType: 'ticket',
    resourceId: ticketId,
    detail: { keys: Object.keys(out) },
  });
  return out;
}

/** Engine-side read: no actor, no permission check, no audit-as-user. System context only.
 *  For internal automation (e.g. provisioning) that needs the raw values, not a user route. */
export async function readSensitiveForEngine(ticketId: string): Promise<Record<string, string>> {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT key, value FROM ticket_sensitive_fields WHERE ticket_id = $1',
      [ticketId],
    );
    return Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  });
}
