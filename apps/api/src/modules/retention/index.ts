// Retention hold creation. All the I/O lives here; classify.ts stays pure.
//
// Spec: docs/superpowers/specs/2026-09-02-offboarding-retention-holds-design.md
import { withSystemContext, type Sql } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { classifyRetention, retainUntil, type PrivilegeEvidence } from './classify.js';

export interface RecordHoldInput {
  organizationId: string;
  runId: string;
  ticketId: string;
  /** Denormalized onto the hold — it must outlive the ticket and the run. */
  upn: string;
  entraObjectId: string;
  displayName: string;
  /** When the teardown actually ran. The retention clock starts here, not on the last day. */
  offboardedAt: Date;
  directoryRoleCount: number;
  /** The departing person's Nexus user id, for the permission and elevation lookups. */
  departingUserId: string | null;
}

/**
 * Gathers the privilege evidence and writes the hold.
 *
 * Called when an offboarding run reaches `succeeded`. A failure here must never fail the run —
 * the teardown genuinely happened, and losing that fact is worse than losing a hold, which can
 * be reconstructed from the run. The caller is responsible for that; see the sweeper.
 */
export async function recordHold(
  input: RecordHoldInput,
): Promise<{ holdId: string | null; retentionClass: string }> {
  const evidence = await gatherEvidence(input);
  const { retentionClass, basis } = classifyRetention(evidence);
  const until = retainUntil(input.offboardedAt, retentionClass);

  const holdId = await withSystemContext(async (sql: Sql) => {
    // ON CONFLICT DO NOTHING against the live-account partial unique index: a second hold for
    // one account is a no-op, not a crash. Re-running a sweep must not blow up on a hold that
    // already exists.
    const { rows } = await sql.query(
      `INSERT INTO retention_holds
         (organization_id, upn, entra_object_id, display_name_at_offboard,
          retention_class, classification_basis, offboarded_at, retain_until,
          run_id, ticket_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        input.organizationId, input.upn, input.entraObjectId, input.displayName,
        retentionClass, JSON.stringify(basis), input.offboardedAt.toISOString(),
        until.toISOString(), input.runId, input.ticketId,
      ],
    );
    return (rows[0]?.id as string | undefined) ?? null;
  });

  logger.info(
    { holdId, retentionClass, retainUntil: until.toISOString(), upn: input.upn },
    holdId ? 'retention hold recorded' : 'retention hold already existed for this account',
  );
  return { holdId, retentionClass };
}

async function gatherEvidence(input: RecordHoldInput): Promise<PrivilegeEvidence> {
  // Without a Nexus user reference the only evidence available is the directory role count. That
  // is a weaker classification, but it is honest — and it still catches the Entra admins.
  if (!input.departingUserId) {
    return { directoryRoleCount: input.directoryRoleCount, nexusPermissions: [], elevationGrants: [] };
  }

  return withSystemContext(async (sql: Sql) => {
    const { rows: perms } = await sql.query(
      `SELECT DISTINCT rp.permission_key AS key
         FROM role_assignments ra
         JOIN role_permissions rp ON rp.role_id = ra.role_id
        WHERE ra.user_id = $1`,
      [input.departingUserId],
    );

    // NO status filter, deliberately. An expired or revoked grant still means the privilege
    // existed, and by the time someone is offboarded their elevation has almost always already
    // lapsed — filtering here would quietly downgrade the very people this rule covers.
    const { rows: grants } = await sql.query(
      'SELECT status, break_glass, granted_permissions FROM elevation_grants WHERE user_id = $1',
      [input.departingUserId],
    );

    return {
      directoryRoleCount: input.directoryRoleCount,
      nexusPermissions: perms.map((p: { key: string }) => p.key),
      elevationGrants: grants as PrivilegeEvidence['elevationGrants'],
    };
  });
}
