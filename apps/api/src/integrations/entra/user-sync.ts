// Loads a customer's Entra staff into Nexus users, so the platform knows who works there before
// they have ever signed in.
//
// Customer SSO already JIT-provisions on first login, so this is NOT what makes login work. It
// exists because everything that needs to NAME a person — the offboarding picker above all —
// reads Nexus users, and a person who has never logged in does not exist to it. Offboarding the
// staff who leave quietly is exactly the case that was unreachable.
import { logger } from '../../logger.js';
import type { Sql } from '../../db/pool.js';

export interface EntraUser {
  id?: string;
  userPrincipalName?: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  userType?: string;
  accountEnabled?: boolean;
  assignedLicenses?: Array<{ skuId?: string }>;
}

export interface MappedUser {
  externalId: string;
  email: string;
  displayName: string;
  givenName: string | null;
  surname: string | null;
}

export interface UserSyncStats {
  created: number;
  /** People whose Entra identity already exists elsewhere in the platform — see the oid lookup. */
  skippedExisting: number;
  /** Existing accounts matched by email and stamped with their Entra oid. */
  linked: number;
  updated: number;
  suspended: number;
  skippedSuspension: boolean;
  skipReason?: string;
}

/**
 * Is this account a person who works here?
 *
 * A licensed Member on the organization's own domain. The tenant carries 123 accounts and only 70
 * pass: the rest are guests, rooms, shared mailboxes and service accounts. They are not people,
 * and importing them would put meeting rooms in the offboarding picker.
 *
 * Licensing is the discriminator that actually works — 51 members on the domain hold no licence,
 * which is what an unattended service account looks like.
 */
export function isStaffAccount(u: EntraUser, upnDomain: string): boolean {
  const upn = (u.userPrincipalName ?? '').trim().toLowerCase();
  if (!upn.endsWith(`@${upnDomain.trim().toLowerCase()}`)) return false;
  if ((u.userType ?? 'Member') !== 'Member') return false;
  return (u.assignedLicenses ?? []).length > 0;
}

export function mapEntraUser(u: EntraUser): MappedUser | null {
  const externalId = u.id;
  const email = (u.userPrincipalName ?? '').trim().toLowerCase();
  if (!externalId || !email) return null;
  return {
    externalId,
    email,
    displayName: (u.displayName ?? '').trim() || email,
    givenName: (u.givenName ?? '').trim() || null,
    surname: (u.surname ?? '').trim() || null,
  };
}

/** Below this many synced users, proportion means nothing; only a total collapse is suspicious. */
const SUSPEND_GUARD_FLOOR = 10;
const SUSPEND_MAX_FRACTION = 0.5;

export function suspensionSkipReason(returned: number, activeSynced: number, wouldSuspend: number): string | null {
  if (activeSynced === 0) return null;
  if (returned === 0) {
    return `the tenant returned no staff accounts while ${activeSynced} synced user(s) are still active`;
  }
  if (activeSynced >= SUSPEND_GUARD_FLOOR && wouldSuspend > activeSynced * SUSPEND_MAX_FRACTION) {
    return `this run would suspend ${wouldSuspend} of ${activeSynced} active users in one pass`;
  }
  return null;
}

export async function applyUserSync(
  sql: Sql,
  orgId: string,
  users: MappedUser[],
  roleKey: string,
): Promise<UserSyncStats> {
  let created = 0; let linked = 0; let updated = 0; let skippedExisting = 0;
  const seen = new Set<string>();

  for (const u of users) {
    seen.add(u.externalId);

    // 1) Already linked by Entra oid. The lookup is GLOBAL, not org-scoped, because
    //    users.external_id carries a global UNIQUE constraint — one Entra identity can only ever
    //    sit on one row. Scoping this to the org made the query miss operators who signed in via
    //    agent SSO and produced a duplicate-key failure mid-import against real data.
    //
    //    It is also the right answer regardless of the constraint: several SBS staff are Nexus
    //    operators, and a second customer-plane row for the same human would list them twice in
    //    the offboarding picker with no way to tell which one is real.
    const byOid = (await sql.query(
      'SELECT id, plane, organization_id FROM users WHERE external_id = $1',
      [u.externalId],
    )).rows[0];
    if (byOid) {
      const sameOrgCustomer = byOid.plane === 'customer' && byOid.organization_id === orgId;
      if (sameOrgCustomer) {
        await sql.query(
          'UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1',
          [byOid.id, u.displayName],
        );
        updated += 1;
      } else {
        // An operator account, or this person in another org. Leave it entirely alone: a tenant
        // read has no business rewriting an operator's identity.
        skippedExisting += 1;
      }
      continue;
    }

    // 2) Same person, no oid yet: created by hand, or before SSO. LINK it — never insert a second
    //    record. Two rows for one human is the failure the operator explicitly asked to avoid,
    //    and it would show them twice in the offboarding picker with no way to tell which is real.
    const byEmail = (await sql.query(
      `SELECT id, plane, external_id FROM users
        WHERE organization_id = $1 AND lower(email) = $2`,
      [orgId, u.email],
    )).rows[0];
    if (byEmail) {
      if (!byEmail.external_id) {
        await sql.query('UPDATE users SET external_id = $1 WHERE id = $2', [u.externalId, byEmail.id]);
        linked += 1;
      } else {
        updated += 1;
      }
      continue;
    }

    // 3) Genuinely new.
    const ins = (await sql.query(
      `INSERT INTO users (plane, organization_id, email, display_name, external_id, status)
       VALUES ('customer', $1, $2, $3, $4, 'active') RETURNING id`,
      [orgId, u.email, u.displayName, u.externalId],
    )).rows[0];
    await sql.query(
      `INSERT INTO role_assignments (user_id, role_id, organization_id)
       SELECT $1, r.id, $2 FROM roles r WHERE r.key = $3
       ON CONFLICT DO NOTHING`,
      [ins.id, orgId, roleKey],
    );
    created += 1;
  }

  // Leavers. Only accounts THIS sync owns (customer plane, carrying an oid) are eligible — a
  // hand-created account or a nexus-plane operator must never be suspended by a tenant read.
  const activeSynced = (await sql.query(
    `SELECT id, email, external_id FROM users
      WHERE organization_id = $1 AND plane = 'customer'
        AND external_id IS NOT NULL AND status = 'active'`,
    [orgId],
  )).rows as Array<{ id: string; email: string; external_id: string }>;

  const toSuspend = activeSynced.filter((r) => !seen.has(r.external_id)).map((r) => r.id);

  // Same guards as the device sync, for a worse failure: suspending a workforce locks everyone
  // out of the portal at once, and a narrowed credential returning three of seventy people is
  // indistinguishable here from sixty-seven resignations.
  const skip = suspensionSkipReason(users.length, activeSynced.length, toSuspend.length);
  if (skip) {
    logger.warn({ org: orgId, activeSynced: activeSynced.length, returned: users.length, skip },
      'entra user sync: suspension skipped — review the tenant and the app registration');
    return { created, skippedExisting, linked, updated, suspended: 0, skippedSuspension: true, skipReason: skip };
  }

  for (const id of toSuspend) {
    // Suspended, never deleted: the account is the anchor for their ticket history.
    await sql.query("UPDATE users SET status='suspended', updated_at=now() WHERE id=$1", [id]);
  }
  return { created, skippedExisting, linked, updated, suspended: toSuspend.length, skippedSuspension: false };
}
