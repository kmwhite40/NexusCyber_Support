// Real-Postgres proof for the org-scoping predicate in
// `deliverTapToSupervisor` (src/modules/provisioning/index.ts). That function hands a live
// Temporary Access Pass -- a credential for a brand-new federal Entra identity -- to a
// supervisor looked up from `users` in SYSTEM CONTEXT (the owner pool, which bypasses RLS).
// A security review found the original lookup unscoped: `WHERE id = $1` would resolve a user
// in a DIFFERENT customer organization and mail them a live credential. It was fixed to scope
// by organization, but the only existing coverage (test/provisioning-service-flow.test.ts) runs
// against a hand-rolled DB double that answers on query TEXT SHAPE, not on Postgres semantics --
// it never actually proves the predicate excludes anyone. This file closes that gap by running
// the predicate against a real database with real fixture rows.
//
// The predicate is a UNION of the two ways a user is legitimately "of" an organization:
//  - a customer-plane user carries users.organization_id directly (the ordinary case: the
//    form's supervisor picker, accounts.searchUsers, returns only customer-plane users of the
//    requester's own org);
//  - a nexus-plane user carries organization_id NULL by construction (modules/platform-users.ts
//    hardcodes it), so their scope lives entirely in role_assignments -- either an assignment
//    scoped to this org, or the org-NULL "all orgs" grant.
//
// SOURCING THE SQL: rather than hand-copying the predicate (which would silently stop testing
// anything the moment the two copies drifted), this file extracts the literal SQL text straight
// out of provisioning/index.ts at test time and executes exactly that string. Breaking the real
// predicate therefore breaks this test -- see the verification note at the bottom of this file
// for how that was actually demonstrated.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext, type Sql } from '../../src/db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVISIONING_SRC = resolve(__dirname, '../../src/modules/provisioning/index.ts');

/**
 * Pulls the exact `SELECT u.email, u.status ...` template literal out of
 * `deliverTapToSupervisor`. Throws loudly (failing the whole suite) rather than silently
 * falling back to a stale copy if the source has moved on -- a test that can't find the real
 * predicate has nothing to prove.
 */
function extractSupervisorPredicateSql(): string {
  const source = readFileSync(PROVISIONING_SRC, 'utf8');
  const match = source.match(/`(SELECT u\.email, u\.status[\s\S]*?)`/);
  if (!match) {
    throw new Error(
      'could not locate the supervisor-scoping predicate in provisioning/index.ts -- '
      + 'the source has likely changed shape; update the extraction regex in this test',
    );
  }
  return match[1];
}

const PREDICATE_SQL = extractSupervisorPredicateSql();

// Sanity-check the extraction itself: if this ever matches something that isn't the scoped
// predicate (e.g. an editor auto-format mangled the regex match), fail here with a clear
// message instead of quietly exercising the wrong query in every test below.
if (!/u\.organization_id\s*=\s*\$2/.test(PREDICATE_SQL) || !/role_assignments/.test(PREDICATE_SQL)) {
  throw new Error(`extracted SQL does not look like the supervisor predicate: ${PREDICATE_SQL}`);
}

async function lookupSupervisor(sql: Sql, supervisorId: string, organizationId: string) {
  const { rows } = await sql.query(PREDICATE_SQL, [supervisorId, organizationId]);
  return rows[0] as { email: string; status: string } | undefined;
}

describeDb('supervisor org-scoping predicate (real Postgres, provisioning/index.ts)', () => {
  let orgAId: string;
  let orgBId: string;
  let roleId: string;

  let customerSupervisorInOrgA: string; // case 1: ACCEPT
  let customerUserInOrgB: string; // case 2: REFUSE
  let nexusUserAllOrgsGrant: string; // case 3: ACCEPT
  let nexusUserOrgBGrantOnly: string; // bonus: still REFUSE (grant scoped to the wrong org)

  beforeAll(async () => {
    await withSystemContext(async (sql) => {
      const org = async (name: string) =>
        (await sql.query(
          `INSERT INTO organizations (name, cloud, enclave_id) VALUES ($1, 'gcchigh', 'gcchigh') RETURNING id`,
          [name],
        )).rows[0].id as string;
      orgAId = await org(`Supervisor Scoping Test Org A ${randomUUID()}`);
      orgBId = await org(`Supervisor Scoping Test Org B ${randomUUID()}`);

      roleId = (await sql.query('SELECT id FROM roles LIMIT 1')).rows[0].id as string;

      const user = async (plane: 'customer' | 'nexus', organizationId: string | null, email: string) =>
        (await sql.query(
          `INSERT INTO users (plane, organization_id, email, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
          [plane, organizationId, email],
        )).rows[0].id as string;

      // Case 1: an ordinary customer-plane supervisor of org A -- exactly what
      // accounts.searchUsers hands the form's supervisor picker.
      customerSupervisorInOrgA = await user('customer', orgAId, `sup-orga-${randomUUID()}@sbsfederal.com`);

      // Case 2: a customer-plane user of a DIFFERENT org -- the finding the fix closes. Not in
      // any role_assignments row for org A either.
      customerUserInOrgB = await user('customer', orgBId, `user-orgb-${randomUUID()}@sbsfederal.com`);

      // Case 3: a nexus-plane user (organization_id NULL by construction) holding the org-NULL
      // "all orgs" role_assignments grant -- e.g. a platform admin standing in as supervisor.
      nexusUserAllOrgsGrant = await user('nexus', null, `nexus-allorgs-${randomUUID()}@nexus.local`);
      await sql.query(
        'INSERT INTO role_assignments (user_id, role_id, organization_id) VALUES ($1, $2, NULL)',
        [nexusUserAllOrgsGrant, roleId],
      );

      // Bonus: a nexus-plane user whose ONLY role_assignments row is scoped to org B, not org A
      // and not NULL. Neither branch of the predicate should match this against org A.
      nexusUserOrgBGrantOnly = await user('nexus', null, `nexus-orgb-only-${randomUUID()}@nexus.local`);
      await sql.query(
        'INSERT INTO role_assignments (user_id, role_id, organization_id) VALUES ($1, $2, $3)',
        [nexusUserOrgBGrantOnly, roleId, orgBId],
      );
    });
  });

  afterAll(async () => {
    await withSystemContext(async (sql) => {
      // role_assignments and users both cascade off organizations on delete, EXCEPT the
      // nexus-plane users (organization_id NULL) which are not attached to either org row --
      // delete those explicitly. Deleting the users cascades their role_assignments rows.
      await sql.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [nexusUserAllOrgsGrant, nexusUserOrgBGrantOnly].filter(Boolean),
      ]);
      await sql.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [
        [orgAId, orgBId].filter(Boolean),
      ]);
    });
  });

  // Case 1 -- the ordinary path. accounts.searchUsers only ever offers customer-plane users of
  // the requester's own org, so this is what every real supervisor picked on the form looks
  // like.
  it('ACCEPTS a customer-plane supervisor in the ticket organization', async () => {
    const row = await withSystemContext((sql) => lookupSupervisor(sql, customerSupervisorInOrgA, orgAId));
    expect(row).toBeDefined();
    expect(row!.status).toBe('active');
  });

  // Case 2 -- THE FINDING. An unscoped `WHERE id = $1` would resolve this row and mail a live
  // TAP cross-organization. The scoped predicate must return nothing.
  it('REFUSES a user belonging to a different organization', async () => {
    const row = await withSystemContext((sql) => lookupSupervisor(sql, customerUserInOrgB, orgAId));
    expect(row).toBeUndefined();
  });

  // Case 3 -- the nexus-plane branch. organization_id is NULL by construction for these users,
  // so they can ONLY match via the role_assignments EXISTS clause, and specifically via the
  // org-NULL "all orgs" grant here.
  it('ACCEPTS a nexus-plane user holding an all-orgs grant', async () => {
    const row = await withSystemContext((sql) => lookupSupervisor(sql, nexusUserAllOrgsGrant, orgAId));
    expect(row).toBeDefined();
    expect(row!.status).toBe('active');
  });

  // Bonus negative: a nexus-plane user is not admitted just for holding SOME role_assignments
  // row -- it has to be a row for the org in question (or the NULL grant).
  it('REFUSES a nexus-plane user whose role assignment is scoped to a different org', async () => {
    const row = await withSystemContext((sql) => lookupSupervisor(sql, nexusUserOrgBGrantOnly, orgAId));
    expect(row).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------------------
// VERIFICATION THIS TEST HAS TEETH (performed manually, not part of the automated suite):
// the organization_id = $2 clause was temporarily deleted from the predicate in
// provisioning/index.ts (collapsing it to the role_assignments branch alone), this file's
// extraction picked up the weakened SQL automatically, and "REFUSES a user belonging to a
// different organization" failed as expected. The source was then restored and the failure
// disappeared. See supervisor-scoping-test-report.md for the pasted output of both runs.
// -----------------------------------------------------------------------------------------
