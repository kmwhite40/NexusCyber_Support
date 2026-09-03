// Pure classification and date arithmetic for retention holds. No I/O — the service gathers the
// evidence and hands it in, so every branch here is testable without a tenant or a database.
//
// Spec: docs/superpowers/specs/2026-09-02-offboarding-retention-holds-design.md

/**
 * Nexus permissions that make an account privileged for retention purposes.
 *
 * Deliberately short. If this grew to include ordinary desk permissions, every account would
 * classify as privileged and the 1-year/7-year distinction would stop meaning anything.
 */
export const PRIVILEGED_NEXUS_PERMISSIONS = [
  'admin.superuser', 'cab.manage', 'provisioning.execute', 'admin.users.manage',
];

export interface PrivilegeEvidence {
  directoryRoleCount: number;
  nexusPermissions: string[];
  elevationGrants: Array<{ status: string; break_glass: boolean; granted_permissions: string[] }>;
}

export interface Classification {
  retentionClass: 'standard' | 'privileged';
  basis: Record<string, unknown>;
}

/**
 * ANY evidence of privilege, EVER.
 *
 * Over-retention is the correct direction to err: keeping a record too long costs storage,
 * keeping it too short is a compliance failure that cannot be undone once the window has passed.
 *
 * NOTE WHAT IS DELIBERATELY NOT FILTERED: an elevation grant counts whatever its status. An
 * expired or revoked grant still means the privilege existed at some point, which is precisely
 * what the seven-year rule is about. Filtering to active grants would look tidier and would
 * silently downgrade exactly the people the rule targets — invisibly, because by the time anyone
 * is offboarded their elevation has almost always already lapsed. If you are reading this because
 * the `status` column looks unused: that is the point.
 */
export function classifyRetention(evidence: PrivilegeEvidence): Classification {
  const privilegedPerms = evidence.nexusPermissions
    .filter((p) => PRIVILEGED_NEXUS_PERMISSIONS.includes(p));

  const privileged = evidence.directoryRoleCount > 0
    || privilegedPerms.length > 0
    || evidence.elevationGrants.length > 0;

  return {
    retentionClass: privileged ? 'privileged' : 'standard',
    // Recorded even when standard: an auditor asking "why is this one only a year?" deserves an
    // answer as much as one asking the reverse.
    basis: {
      directoryRoleCount: evidence.directoryRoleCount,
      nexusPermissions: privilegedPerms,
      elevationGrants: evidence.elevationGrants.map((g) => ({
        status: g.status, breakGlass: g.break_glass, permissions: g.granted_permissions,
      })),
    },
  };
}

const YEARS: Record<'standard' | 'privileged', number> = { standard: 1, privileged: 7 };

/**
 * The retention date, measured from run completion — the account's disabled life begins when the
 * teardown actually ran, not on the last day worked.
 *
 * Clamps a leap day to the end of February rather than letting JavaScript roll it into March.
 * A retention date that silently drifts by a day is one nobody can reconcile against a record
 * seven years later, and reconciliation is the entire purpose of storing it.
 */
export function retainUntil(offboardedAt: Date, retentionClass: 'standard' | 'privileged'): Date {
  const out = new Date(offboardedAt.getTime()); // copy: never mutate the caller's date
  const targetYear = out.getUTCFullYear() + YEARS[retentionClass];
  const month = out.getUTCMonth();
  const day = out.getUTCDate();
  const lastOfTargetMonth = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  out.setUTCFullYear(targetYear, month, Math.min(day, lastOfTargetMonth));
  return out;
}
