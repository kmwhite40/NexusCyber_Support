// Offboarding service layer: the one place the planner, the executor, Microsoft Graph and the
// database meet.
//
// THE GUARANTEE THIS FILE KEEPS: `preview` and `schedule` build their plan through the SAME
// buildPlan() call, so the dry run an admin approves is provably the plan that gets armed. Do
// not add a second way to construct an OffboardPlan.
//
// Layering, mirroring modules/provisioning: the planner is pure (no I/O), the executor is
// pure-with-injected-ops (no Graph imports). All the I/O — DB reads, Graph reads, Graph writes —
// lives here.
//
// This module does NOT import modules/provisioning/index.ts. It borrows that engine's discipline,
// not its code path: onboarding creates and offboarding destroys, and a fault in the destructive
// half must not be able to reach the half that provisions live federal identities. The two pure
// helpers it does import (deriveUpn, and the Graph ops) perform no I/O and hold no state.
import { withSystemContext, withOrgContext, type Sql } from '../../db/pool.js';
import { orgContextFor } from '../../auth/principal.js';
import { authorize } from '../../authz/pdp.js';
import { audit } from '../audit.js';
import { Errors } from '../../errors.js';
import { config } from '../../config.js';
import { getProvisioningGraph } from '../../integrations/m365/provisioning-runtime.js';
import {
  findUserByUpn, directoryRoleCount, userLicenseSkuIds,
  setAccountEnabled, revokeSignInSessions, setDisplayName, removeLicenses, removeFromGroup,
} from '../../integrations/m365/provisioning-graph.js';
import { planOffboard, offboardFingerprint, type OffboardPlan, type OffboardPlanInput } from './planner.js';
import type { OffboardOps } from './executor.js';
import type { Principal } from '../../types.js';

/** The catalog item this engine offboards for. Nothing else may drive a directory teardown. */
const OFFBOARDING_CATALOG_KEY = 'user.offboarding';

interface TicketRow {
  id: string;
  organization_id: string;
  category: string | null;
  custom_fields: Record<string, unknown> | null;
}

/**
 * TWO gates, and both are load-bearing.
 *
 * `enabled` is the shared tenant configuration: no credentials, no teardown, ever. But a single
 * shared flag also meant that switching on ONBOARDING silently armed account teardown — sweeper
 * included — on the same deploy. Nobody should have to accept the destructive half in order to
 * get the constructive one, so `offboardingEnabled` is ANDed on top (see config.ts), never
 * substituted for it.
 *
 * Read straight from config rather than through the provisioning module, so this file imports
 * nothing from the flow it must stay separable from.
 */
function requireEnabled(): void {
  if (!config.provisioning.enabled) {
    throw Errors.badRequest('provisioning is not enabled on this deployment');
  }
  if (!config.provisioning.offboardingEnabled) {
    throw Errors.badRequest('offboarding is not enabled on this deployment');
  }
}

/** Whether this deployment may offboard — the same two gates requireEnabled() refuses on. */
export function isEnabled(): boolean {
  return config.provisioning.enabled && config.provisioning.offboardingEnabled;
}

async function loadTicket(ticketId: string): Promise<TicketRow> {
  const ticket = await withSystemContext(async (sql: Sql) => {
    const { rows } = await sql.query(
      'SELECT id, organization_id, category, custom_fields FROM tickets WHERE id = $1',
      [ticketId],
    );
    return rows[0] as TicketRow | undefined;
  });
  if (!ticket) throw Errors.notFound('ticket not found');
  return ticket;
}

/**
 * Reads everything the pure planner needs from the tenant and the ticket.
 *
 * mailboxType is the honest weak spot: Graph exposes no reliable user-vs-shared mailbox
 * discriminator, so a licensed account is treated as having a user mailbox and an unlicensed one
 * as having none. That is good enough BECAUSE the conversion step is manual — the tech performing
 * it sees the real mailbox in Exchange and confirms or skips accordingly. If mailbox conversion
 * ever becomes automatable, this inference must be replaced with a real lookup first.
 */
export async function readOffboardTenantState(ticketId: string): Promise<OffboardPlanInput & { ticket: TicketRow }> {
  const ticket = await loadTicket(ticketId);
  const answers = (ticket.custom_fields ?? {}) as Record<string, unknown>;

  // WHO is being offboarded comes from the ticket's `departing_user` reference — the only
  // identity the offboarding intake actually captures. Deriving a UPN from name fields (as the
  // onboarding planner does) is wrong here: this form has no name fields, so every derivation
  // produced ".@<domain>", matched nothing, and the feature could never arm a run.
  const departingUpn = await resolveDepartingUpn(answers);

  // No resolvable person means nothing to look up. Skipping the Graph call keeps a malformed
  // request from spending a tenant round trip, and the planner reports it as a blocker.
  const g = departingUpn ? await getProvisioningGraph() : null;
  const user = g && departingUpn ? await findUserByUpn(g.graph, departingUpn) : null;

  const roleCount = g && user ? await directoryRoleCount(g.graph, user.id) : 0;
  const licenseSkuIds = g && user ? await userLicenseSkuIds(g.graph, user.id) : [];
  const groupIds = g && user ? await userGroupIds(g.graph, user.id) : [];

  return {
    answers,
    departingUpn,
    user: user
      ? {
        id: user.id,
        userPrincipalName: user.userPrincipalName ?? departingUpn!,
        displayName: user.displayName ?? '',
        accountEnabled: user.accountEnabled !== false,
        givenName: user.givenName ?? undefined,
        surname: user.surname ?? undefined,
      }
      : null,
    directoryRoleCount: roleCount,
    licenseSkuIds,
    groupIds,
    mailboxType: licenseSkuIds.length > 0 ? 'user' : 'none',
    ticket,
  };
}

/**
 * The departing person's UPN, from their Nexus user record.
 *
 * The intake stores `departing_user` as a user REFERENCE (form field type `user`, maps_to
 * `affected`), so the ticket and the directory action point at the same person by construction
 * rather than by someone retyping a name. Returns null when the answer is absent or names
 * nobody — the planner turns that into a readable blocker.
 */
async function resolveDepartingUpn(answers: Record<string, unknown>): Promise<string | null> {
  const ref = answers.departing_user;
  if (typeof ref !== 'string' || !ref.trim()) return null;
  return withSystemContext(async (sql: Sql) => {
    const { rows } = await sql.query('SELECT email FROM users WHERE id = $1', [ref]);
    const email = rows[0]?.email as string | undefined;
    return email ? email.trim().toLowerCase() : null;
  });
}

/** Group and distribution-list memberships. Directory roles are counted separately. */
async function userGroupIds(graph: { get: (p: string) => Promise<any> }, userId: string): Promise<string[]> {
  const res = await graph.get(`/users/${userId}/memberOf`);
  const values = Array.isArray(res?.value) ? res.value : [];
  return values
    .filter((v: any) => String(v?.['@odata.type'] ?? '').includes('group'))
    .map((v: any) => String(v.id))
    .filter(Boolean);
}

/** THE ONLY planning path. Both preview and schedule come through here. */
async function buildPlan(ticketId: string): Promise<{ plan: OffboardPlan; ticket: TicketRow; userId: string | null }> {
  const state = await readOffboardTenantState(ticketId);
  return { plan: planOffboard(state), ticket: state.ticket, userId: state.user?.id ?? null };
}

export type PreviewedOffboardPlan = OffboardPlan & { fingerprint: string };

/** Dry run. Reads tenant state, writes nothing. Safe to click repeatedly. */
export async function preview(actor: Principal, ticketId: string): Promise<PreviewedOffboardPlan> {
  requireEnabled();
  const ticket = await loadTicket(ticketId);
  authorize(actor, 'provisioning.execute', { organizationId: ticket.organization_id });
  if (ticket.category !== OFFBOARDING_CATALOG_KEY) {
    throw Errors.badRequest(`only a ${OFFBOARDING_CATALOG_KEY} request can be offboarded`);
  }
  const { plan } = await buildPlan(ticketId);
  return { ...plan, fingerprint: offboardFingerprint(plan) };
}

/**
 * Arms an approved plan to fire at HR's instant. Writes no directory changes itself — the
 * sweeper does that when the clock reaches `scheduledFor`.
 */
export async function schedule(
  actor: Principal,
  ticketId: string,
  fingerprint: string,
  scheduledFor: string,
): Promise<{ runId: string; status: string; scheduledFor: string }> {
  requireEnabled();
  const ticket = await loadTicket(ticketId);
  authorize(actor, 'provisioning.execute', { organizationId: ticket.organization_id });

  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) {
    throw Errors.badRequest('scheduled_for is not a valid instant');
  }
  // Arming for a moment that has already passed would fire on the very next sweep, which is not
  // what "schedule" means and not what the approver read.
  if (when.getTime() <= Date.now()) {
    throw Errors.badRequest('scheduled_for is in the past');
  }

  const { plan } = await buildPlan(ticketId);
  if (plan.blockers.length > 0) {
    throw Errors.badRequest(
      `plan carries ${plan.blockers.length} blocker(s); refusing to schedule`,
    );
  }
  // The plan the admin READ is the plan that gets armed, or nothing is armed.
  if (offboardFingerprint(plan) !== fingerprint) {
    throw Errors.preconditionFailed(
      'The plan changed since you previewed it, so nothing was scheduled. Preview again and review the new plan before scheduling.',
    );
  }

  const runId = await withOrgContext(orgContextFor(actor), async (sql: Sql) => {
    const { rows } = await sql.query(
      `INSERT INTO provisioning_runs
         (ticket_id, organization_id, kind, status, scheduled_for, plan, started_by)
       VALUES ($1,$2,'offboarding','scheduled',$3,$4::jsonb,$5)
       RETURNING id`,
      [ticket.id, ticket.organization_id, when.toISOString(),
        JSON.stringify({ ...plan, fingerprint }), actor.id],
    );
    return rows[0]?.id as string;
  });

  await audit(actor, {
    action: 'offboarding.schedule',
    organizationId: ticket.organization_id,
    resourceType: 'ticket',
    resourceId: ticketId,
    detail: { runId, scheduledFor: when.toISOString(), privileged: plan.privileged },
  });

  return { runId, status: 'scheduled', scheduledFor: when.toISOString() };
}

/**
 * Run history for a ticket. Caller-scoped (RLS applies), and deliberately NOT gated on the
 * feature flag: turning offboarding off must not erase the record of what it did while on.
 */
export async function listRuns(actor: Principal, ticketId: string) {
  return withOrgContext(orgContextFor(actor), async (sql: Sql) => {
    const { rows: runs } = await sql.query(
      `SELECT id, ticket_id, organization_id, status, scheduled_for, plan,
              started_by, started_at, finished_at, error, created_at
         FROM provisioning_runs
        WHERE ticket_id = $1 AND kind = 'offboarding'
        ORDER BY created_at DESC`,
      [ticketId],
    );
    if (runs.length === 0) return [];
    const { rows: steps } = await sql.query(
      `SELECT run_id, step_key, position, status, graph_object_id, error, started_at, finished_at
         FROM provisioning_steps WHERE run_id = ANY($1::uuid[]) ORDER BY position`,
      [runs.map((r: { id: string }) => r.id)],
    );
    return runs.map((r: { id: string }) => ({
      ...r,
      steps: steps.filter((s: { run_id: string }) => s.run_id === r.id),
    }));
  });
}

/**
 * Binds the Graph operations and the evidence writer for one run. The executor receives only
 * this — it never sees a GraphClient or a database handle.
 */
export async function buildOffboardOps(runId: string, organizationId: string): Promise<OffboardOps> {
  const g = await getProvisioningGraph();
  let position = 0;
  return {
    blockSignin: (userId) => setAccountEnabled(g.graph, userId, false),
    revokeSessions: (userId) => revokeSignInSessions(g.graph, userId),
    rename: (userId, displayName) => setDisplayName(g.graph, userId, displayName),
    removeLicenses: (userId, skuIds) => removeLicenses(g.graph, userId, skuIds),
    removeFromGroups: async (userId, groupIds) => {
      // Sequential, not Promise.all: a partial failure must leave a comprehensible trail, and
      // Graph throttles hard on parallel membership writes.
      for (const groupId of groupIds) await removeFromGroup(g.graph, groupId, userId);
    },
    recordStep: async (key, status, detail) => {
      position += 1;
      await withSystemContext(async (sql: Sql) => {
        // organization_id is supplied explicitly: RLS is NOT inherited through the run FK.
        await sql.query(
          `INSERT INTO provisioning_steps
             (run_id, organization_id, step_key, position, status, error, finished_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())`,
          [runId, organizationId, key, position, status === 'awaiting_manual' ? 'pending' : status,
            (detail as { error?: string }).error ?? null],
        );
      });
    },
  };
}
