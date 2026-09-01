// Provisioning service layer: the one place the planner, the executor, Microsoft Graph and the
// database meet.
//
// THE GUARANTEE THIS FILE EXISTS TO KEEP: `preview` and `provision` build their plan through
// the SAME buildPlan() call. There is exactly one planning path, so the dry run an admin
// approves is provably the plan that executes. Do not add a second way to construct a Plan —
// not "a quick preview that skips the group lookup", not a cached plan replayed from the runs
// table. If preview and provision could ever disagree, the admin's approval would be
// meaningless and this whole design collapses.
//
// One code path was necessary but NOT sufficient, and that gap was a real defect. Both calls
// ran the same code over DIFFERENT DATA: any write to tickets.custom_fields, the sensitive
// store, or the tenant's own groups and policies between the two clicks silently changed the
// UPN, the group list and the Cloud PC policy that got created, with the admin's approval
// still attached to a plan nobody ever saw executed. `preview` therefore returns a
// `fingerprint` (planner.ts: planFingerprint), `provision` REQUIRES it, and a fresh plan that
// does not hash to the same value is refused with 412 rather than executed. An execute with no
// fingerprint at all is refused too — silence is not consent.
//
// Layering: the planner is pure (no I/O), the executor is pure-with-injected-ops (no Graph
// imports). All the I/O — DB reads, Graph reads, Graph writes, notification delivery — lives
// here.
import { withSystemContext, withOrgContext, type Sql } from '../../db/pool.js';
import { orgContextFor } from '../../auth/principal.js';
import { authorize } from '../../authz/pdp.js';
import { audit } from '../audit.js';
import { Errors } from '../../errors.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { readSensitiveForEngine } from '../sensitive-fields.js';
import { getProvisioningGraph, type ProvisioningGraph } from '../../integrations/m365/provisioning-runtime.js';
import { getNotificationAdapter } from '../../integrations/m365/runtime.js';
import type { DeliveryResult } from '../../integrations/m365/adapter.js';
import {
  readTenantState,
  findUserByUpn,
  directoryRoleCount,
  createUser,
  assignLicenses,
  userLicenseSkuIds,
  addToGroup,
  issueTap,
  listGroupsByDisplayName,
  normalizePolicies,
  isTapPolicyDisabledError,
  type DirectoryGroup,
} from '../../integrations/m365/provisioning-graph.js';
import { planRun, deriveUpn, planFingerprint, type Plan } from './planner.js';
import {
  executePlan, TapPolicyUnavailableError, TAP_SKIPPED_NOTICE,
  type ProvisioningOps, type StepOutcome,
} from './executor.js';
import type { Principal } from '../../types.js';

// ---------------------------------------------------------------------------
// Pure decision functions (unit-tested directly in test/provisioning-service.test.ts)
// ---------------------------------------------------------------------------

/**
 * Maps requested group NAMES to directory ids. Pure.
 *
 * Matching is case- and whitespace-insensitive because these names are free text typed on a
 * request form, not picked from a list. A name that does not resolve is REPORTED, never
 * dropped: silently skipping it would hand the new hire an account missing the access their
 * supervisor asked for, with nothing anywhere saying so.
 */
export function resolveGroupIds(
  names: string[],
  directory: DirectoryGroup[],
): { groupIds: string[]; missing: string[] } {
  const byName = new Map(directory.map((g) => [g.displayName.trim().toLowerCase(), g.id]));
  const groupIds: string[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const id = byName.get(n.trim().toLowerCase());
    if (!id) { missing.push(n); continue; }
    // The same group can be named twice (e.g. "All Staff" and "all staff" on one form).
    // Adding a member twice is an error in Graph, so de-duplicate here rather than in the
    // executor, which should only ever see a clean list.
    if (!groupIds.includes(id)) groupIds.push(id);
  }
  return { groupIds, missing };
}

/**
 * THE SEAM between the pure planner (Task 11) and the executor (Task 13). Pure.
 *
 * The planner cannot do I/O, so its `add_groups` step carries group *names*. The executor
 * consumes group *ids* — and, as of its latest revision, throws outright if names are present
 * with no ids, precisely so this step can never be skipped by accident. This function is the
 * bridge: it writes `detail.groupIds`, and turns every unresolved name into a `group_missing`
 * blocker (which the executor then refuses to run at all).
 *
 * Returns a NEW plan rather than mutating the input: a Plan is the record of what an admin
 * approved, and something that has been handed out should not change under the holder.
 */
export function applyGroupResolution(plan: Plan, directory: DirectoryGroup[]): Plan {
  const groupStep = plan.steps.find((s) => s.key === 'add_groups');
  if (!groupStep) return plan;
  const names = Array.isArray(groupStep.detail.groups)
    ? (groupStep.detail.groups as unknown[]).map(String)
    : [];
  const { groupIds, missing } = resolveGroupIds(names, directory);
  return {
    ...plan,
    steps: plan.steps.map((s) =>
      s === groupStep ? { ...s, detail: { ...s.detail, groupIds } } : s,
    ),
    blockers: [
      ...plan.blockers,
      ...missing.map((name) => ({
        code: 'group_missing',
        message: `Group "${name}" was not found in the directory.`,
      })),
    ],
  };
}

/** Group names the plan asks for, or [] when it has no group step. Pure. */
function requestedGroupNames(plan: Plan): string[] {
  const step = plan.steps.find((s) => s.key === 'add_groups');
  if (!step || !Array.isArray(step.detail.groups)) return [];
  return (step.detail.groups as unknown[]).map(String);
}

// ---------------------------------------------------------------------------
// The single planning path
// ---------------------------------------------------------------------------

/**
 * The run statuses that mean a run is STILL IN FLIGHT for its ticket, and therefore block a
 * second one from starting.
 *
 * `awaiting_cloudpc` belongs here and its omission was a real hole: a Cloud PC build takes
 * 30-90 minutes and this codebase documents that wait as a NORMAL resting state (see
 * ../../jobs/cloudpc-poller.ts), so it is BY FAR the longest window in which an impatient admin
 * re-clicks "Provision". A second run started then mints a second Temporary Access Pass and
 * repeats the group adds against the same identity — exactly what this guard exists to prevent.
 * Only a finished run ('succeeded' / 'failed', and a never-started 'planned') may be retried.
 */
export const IN_FLIGHT_RUN_STATUSES = ['running', 'awaiting_cloudpc'] as const;

interface TicketRow {
  id: string;
  organization_id: string;
  /** service_catalog_items.key this request was raised from (catalog.ts writes it here). */
  category: string | null;
  custom_fields: Record<string, unknown> | null;
}

function requireEnabled(): void {
  // A clear, typed refusal — not a Graph auth crash or an "unknown cloud environment" 500 —
  // is what "the feature stays dark" has to look like from the outside.
  if (!config.provisioning.enabled) {
    throw Errors.badRequest('provisioning is not enabled on this deployment');
  }
}

async function loadTicket(ticketId: string): Promise<TicketRow> {
  const ticket = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT id, organization_id, category, custom_fields FROM tickets WHERE id = $1',
      [ticketId],
    );
    return rows[0] as TicketRow | undefined;
  });
  if (!ticket) throw Errors.notFound('ticket not found');
  return ticket;
}

/** The catalog item this engine provisions for. Nothing else may drive a directory write. */
const ONBOARDING_CATALOG_KEY = 'user.provisioning';

/**
 * Binds a run to the ONE organization that owns the provisioning tenant.
 *
 * `listCloudPcPolicies` already scopes its read this way, but preview/provision — the calls that
 * actually WRITE to a live federal directory — did not: they authorized `provisioning.execute`
 * against whatever organization the ticket happened to belong to. A holder of that permission
 * scoped to some other customer org could therefore drive account creation, licence assignment
 * and Cloud PC group membership into the SBS tenant from a ticket in their own org. The tenant
 * is single (see the spec's "Tenant scope" decision), so the owning org is single too, and any
 * other org is simply not a place a provisioning run can come from.
 *
 * Unlike the options provider, this REFUSES rather than degrading: an options list with nothing
 * to offer is an honest empty list, but a write request from the wrong org is a request that
 * must not proceed quietly.
 */
async function requireProvisioningTenantOrg(ticket: TicketRow): Promise<void> {
  const tenantOrg = await provisioningOrganizationId();
  if (!tenantOrg) {
    throw Errors.badRequest(
      'no organization is mapped to the provisioning tenant (organizations.entra_tenant_id), '
      + 'so there is no tenant this ticket could provision into',
    );
  }
  if (ticket.organization_id !== tenantOrg) {
    throw Errors.badRequest(
      'this ticket does not belong to the organization that owns the provisioning tenant',
    );
  }
}

/**
 * THE HUMAN-IN-THE-LOOP GATE, server-side.
 *
 * "Approval completes, an admin reviews a preview, then clicks Provision" is the decision the
 * entire design rests on (spec, "Automation boundary") — and it was enforced only in React:
 * the ticket page computed `approvalsPassed` and hid the panel, while the API executed on any
 * ticket, in any approval state, for any holder of `provisioning.execute`. A hidden button is
 * not an authorization control; anything that can call the endpoint bypassed it entirely.
 *
 * Three things are checked here, all of them state the client cannot assert:
 *  1. the ticket really is a `user.provisioning` catalog request — the only intake whose form
 *     answers this planner knows how to read — and that item still carries a form;
 *  2. an approval record EXISTS. The catalog item is `requires_approval`, so a request with no
 *     approvals at all did not come through the intake this gate governs. (The client's rule
 *     was the opposite: no approvals meant "passed".)
 *  3. every approval on it is `approved` — none requested, none rejected.
 */
async function requireApprovedOnboardingRequest(ticket: TicketRow): Promise<void> {
  const { item, approvals } = await withSystemContext(async (sql) => {
    const { rows: itemRows } = await sql.query(
      'SELECT key, form_key FROM service_catalog_items WHERE key = $1 AND active',
      [ticket.category ?? ''],
    );
    const { rows: approvalRows } = await sql.query(
      "SELECT status FROM approvals WHERE subject_type = 'ticket' AND subject_id = $1",
      [ticket.id],
    );
    return {
      item: itemRows[0] as { key: string; form_key: string | null } | undefined,
      approvals: approvalRows as Array<{ status: string }>,
    };
  });

  if (ticket.category !== ONBOARDING_CATALOG_KEY || !item?.form_key) {
    throw Errors.badRequest(
      `only an active ${ONBOARDING_CATALOG_KEY} catalog request can be provisioned`,
    );
  }
  if (approvals.length === 0) {
    throw Errors.badRequest(
      'this request carries no approval record; provisioning requires a completed approval',
    );
  }
  const outstanding = approvals.filter((a) => a.status !== 'approved');
  if (outstanding.length > 0) {
    throw Errors.badRequest(
      `provisioning requires every approval to be approved; ${outstanding.length} is not `
      + `(${[...new Set(outstanding.map((a) => a.status))].join(', ')})`,
    );
  }
}

/**
 * Builds the plan for a ticket. THE ONLY planning path — see the file header.
 *
 * Reads the ticket in system context (the PII half of the answers lives outside
 * tickets.custom_fields and is deliberately unreadable through a normal ticket read), then
 * enforces the caller's permission against the ticket's own organization before any Graph
 * traffic. Everything the planner needs is gathered here and handed in; the planner itself
 * stays pure.
 */
async function buildPlan(actor: Principal, ticketId: string): Promise<{ plan: Plan; ticket: TicketRow }> {
  requireEnabled();
  const ticket = await loadTicket(ticketId);
  authorize(actor, 'provisioning.execute', { organizationId: ticket.organization_id });
  await requireProvisioningTenantOrg(ticket);

  // PII lives outside custom_fields; the engine reads it in system context. The sensitive bag
  // wins on a key collision — it is the authoritative store for any field marked sensitive.
  const answers = { ...(ticket.custom_fields ?? {}), ...(await readSensitiveForEngine(ticketId)) };

  const g = await getProvisioningGraph();
  const tenant = await readTenantState(g.graph, g.cloudPc);
  const upn = deriveUpn(answers, config.provisioning.upnDomain);
  const existingUser = await findUserByUpn(g.graph, upn);
  const existingRoleCount = existingUser ? await directoryRoleCount(g.graph, existingUser.id) : 0;

  const planned = planRun({
    answers,
    tenant,
    upnDomain: config.provisioning.upnDomain,
    baselineSkus: config.provisioning.baselineSkus,
    existingUser,
    existingRoleCount,
  });

  // Resolve group names -> ids. Only the names this plan actually asks for are looked up, so
  // the size of the tenant's directory is irrelevant and there is no pagination to truncate.
  const names = requestedGroupNames(planned);
  const directory = names.length ? await listGroupsByDisplayName(g.graph, names) : [];
  return { plan: applyGroupResolution(planned, directory), ticket };
}

/** A previewed plan plus the token that binds it to the run the admin then approves. */
export type PreviewedPlan = Plan & { fingerprint: string };

/**
 * Dry run. Same plan, same blockers, same group resolution as provision() — by construction.
 *
 * Returns the plan's fingerprint alongside it. That value is what the caller must hand back to
 * `provision`; it is what turns "the same code path" into "the same plan". See the file header.
 */
export async function preview(actor: Principal, ticketId: string): Promise<PreviewedPlan> {
  const { plan } = await buildPlan(actor, ticketId);
  return { ...plan, fingerprint: planFingerprint(plan) };
}

// ---------------------------------------------------------------------------
// Graph + notification ops for the executor
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hands the Temporary Access Pass to the supervisor's WORK mailbox — the address Nexus holds
 * for them as a user of this platform — and never to the personal email address captured on
 * the onboarding form, which is PII about the *new hire* and not a credential channel.
 *
 * TAP containment rules observed here:
 *  - the pass is placed in the message body and nowhere else; it is never logged (both mail
 *    adapters log only `to` and `subject`), never written to notification_deliveries (which
 *    stores no body), never returned to the caller;
 *  - errors thrown from here carry no message content, so the pass cannot ride out on one
 *    (the executor also redacts by literal value as a second layer).
 */
async function deliverTapToSupervisor(
  organizationId: string,
  supervisorId: string,
  upn: string,
  pass: string,
): Promise<void> {
  if (!supervisorId) {
    throw new Error('no supervisor on the request; the Temporary Access Pass has nowhere to go');
  }
  if (!UUID_RE.test(supervisorId)) {
    // The form's supervisor field is a user picker, so this is a malformed request rather than
    // a missing user — say so instead of letting Postgres raise a uuid cast error.
    throw new Error('supervisor on the request is not a valid Nexus user reference');
  }
  // SCOPED, not just looked up. The form layer validates the `supervisor` answer as "some
  // string", so the id reaching here is attacker-controlled in the ordinary sense: whoever
  // filled the form chose it. An unscoped `WHERE id = $1` in system context (which is what this
  // was) would happily resolve a user in a DIFFERENT customer organization, or a customer-plane
  // end user, and mail them a live Temporary Access Pass for a brand-new federal identity.
  //
  // Two constraints, both required:
  //  - `plane = 'nexus'` — the pass goes to a work mailbox Nexus itself holds for a platform
  //    operator, never to a customer-plane mailbox this platform merely knows an address for;
  //  - scoped to the TICKET's organization. Nexus users carry organization_id NULL by
  //    construction (see modules/platform-users.ts), so their org scope lives in
  //    role_assignments — an assignment in this org, or the org-NULL all-orgs grant. That is
  //    the same scoping model the PDP applies, so "can this person be sent this org's
  //    credential" means the same thing here as it does everywhere else.
  const supervisor = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT u.email, u.status
         FROM users u
        WHERE u.id = $1
          AND u.plane = 'nexus'
          AND EXISTS (
            SELECT 1 FROM role_assignments ra
             WHERE ra.user_id = u.id
               AND (ra.organization_id = $2 OR ra.organization_id IS NULL)
          )`,
      [supervisorId, organizationId],
    );
    return rows[0] as { email: string; status: string } | undefined;
  });
  if (!supervisor?.email) {
    throw new Error(
      'supervisor is not a Nexus platform user scoped to this organization, or has no work '
      + 'mailbox on file; refusing to deliver the Temporary Access Pass',
    );
  }
  // A deactivated or offboarded supervisor must not receive a live credential for a brand-new
  // account: their mailbox may be delegated, forwarded, shared with a successor, or simply
  // unattended. The onboarding request outlived the supervisor's account — that needs a human
  // to redirect it, so fail the step rather than send the pass somewhere nobody is accountable.
  if (supervisor.status !== 'active') {
    throw new Error(
      `supervisor's Nexus account is ${supervisor.status}, not active; refusing to send the Temporary Access Pass`,
    );
  }

  const adapter = await getNotificationAdapter();
  // The console adapter reports `sent` without sending anything — that is correct for ordinary
  // notifications in dev, and completely wrong here: a TAP has already been minted against a
  // live tenant by this point, and reporting a run as succeeded while the pass went nowhere
  // would leave an account nobody can sign into and no record of why. Fail the step instead;
  // the admin re-runs, which issues a fresh pass.
  if (adapter.name !== 'graph' || !adapter.capabilities().email) {
    throw new Error(
      'no real email transport is configured (M365 mail is not enabled), so the Temporary Access Pass could not be delivered',
    );
  }

  const subject = `Temporary Access Pass for ${upn}`;
  const text = [
    `A Temporary Access Pass has been issued for the new account ${upn}.`,
    '',
    `Pass: ${pass}`,
    '',
    'It is single-use and expires in 8 hours. Give it to the new user in person or by phone —',
    'do not forward this email. They will be asked to set up their own sign-in method with it.',
  ].join('\n');
  const html = `<p>A Temporary Access Pass has been issued for the new account <b>${escapeHtml(upn)}</b>.</p>`
    + `<p><b>Pass:</b> <code>${escapeHtml(pass)}</code></p>`
    + '<p>It is single-use and expires in 8 hours. Give it to the new user in person or by phone —'
    + ' do not forward this email. They will be asked to set up their own sign-in method with it.</p>';

  // Wrapped for the same reason issueTap's adapter wrapper is: a mail adapter that throws
  // commonly echoes the message it was asked to send — and this message's body IS the pass.
  // Unwrapped, containment rested entirely on the executor's second, by-literal-value redaction
  // layer; one layer is not a control. Rethrow a fixed string, and log the real error where a
  // log is the sink rather than a step row and a ticket note.
  let result: DeliveryResult;
  try {
    result = await adapter.sendEmail({ to: supervisor.email, subject, html, text });
  } catch (err) {
    logger.error({ err, organizationId }, 'sending the Temporary Access Pass to the supervisor threw');
    throw new Error('sending the Temporary Access Pass to the supervisor failed');
  }

  // Same delivery ledger every other notification lands in — recipient and status only, so the
  // compliance record shows the pass was handed over without recording the pass itself.
  await withSystemContext(async (sql) => {
    await sql.query(
      `INSERT INTO notification_deliveries
         (organization_id, event_type, channel, recipient, status, provider_message_id)
       VALUES ($1,'provisioning.tap_delivered','email',$2,$3,$4)`,
      [organizationId, supervisor.email, result.status, result.providerMessageId ?? null],
    );
  });

  if (result.status !== 'sent') {
    // Deliberately does NOT interpolate result.error: an adapter's error text is arbitrary
    // provider output, and this string ends up in a step row and a ticket note.
    throw new Error('sending the Temporary Access Pass to the supervisor failed');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Wires the Task 10 Graph adapter (and the mail path) into the executor's injected ops. */
function buildOps(g: ProvisioningGraph, organizationId: string): ProvisioningOps {
  return {
    findUser: (upn) => findUserByUpn(g.graph, upn),
    createUser: (body) => createUser(g.graph, body) as Promise<{ id: string }>,
    currentLicenses: (userId) => userLicenseSkuIds(g.graph, userId),
    assignLicenses: (userId, skuIds) => assignLicenses(g.graph, userId, skuIds),
    // The graph endpoint comes from the same cloud_environments row the client was built from,
    // so the @odata.id host always matches the host we are authenticated against.
    addToGroup: (groupId, userId) => addToGroup(g.graph, groupId, userId, g.graphEndpoint),
    issueTap: async (userId) => {
      // Closes the residual risk parked earlier: if the TAP request fails AFTER Graph has
      // minted a pass server-side, the executor holds no value to redact with. So this adapter
      // never lets the Graph response anywhere near an error message — a failure here is
      // reported as status only, and the response object itself is reduced to the one field the
      // executor needs before it is returned. Nothing else from that payload leaves this scope.
      let res: any;
      try {
        res = await issueTap(g.graph, userId);
      } catch (err) {
        // Spec open item #4. The one Graph failure here that is a TENANT CONFIGURATION fact
        // rather than a run failure is "the Temporary Access Pass method is not enabled".
        // Classified HERE, where the Graph error is still intact, and re-raised as the
        // executor's own marker type — the executor never reads a Graph error body, and every
        // other failure keeps failing the run exactly as before. No pass exists yet at this
        // point, so nothing needs redacting on this path.
        if (isTapPolicyDisabledError(err)) {
          logger.warn({ userId }, 'tenant has no Temporary Access Pass policy; skipping issue_tap');
          throw new TapPolicyUnavailableError();
        }
        const status = (err as { status?: number })?.status;
        throw new Error(`issuing the Temporary Access Pass failed${status ? ` (Graph ${status})` : ''}`);
      }
      const pass = typeof res?.temporaryAccessPass === 'string' ? res.temporaryAccessPass : '';
      if (!pass) throw new Error('Graph did not return a Temporary Access Pass');
      return { temporaryAccessPass: pass };
    },
    deliverTap: (supervisorId, upn, pass) =>
      deliverTapToSupervisor(organizationId, supervisorId, upn, pass),
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** The partial unique index from migration 0057 — at most one in-flight run per ticket. */
const IN_FLIGHT_UNIQUE_INDEX = 'provisioning_runs_one_inflight_per_ticket';

/**
 * Is this the loser of a concurrent-provision race, rather than some other constraint failure?
 *
 * Matched on SQLSTATE 23505 (unique_violation) AND the specific index name, not on 23505 alone:
 * a different unique violation from that INSERT would mean something genuinely unexpected, and
 * reporting it as "a run is already in progress" would send an admin chasing the wrong thing.
 * pg surfaces `constraint` for a named index; the message check is a fallback for drivers or
 * wrappers that do not populate it.
 */
function isInFlightUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string } | null;
  if (e?.code !== '23505') return false;
  return e.constraint === IN_FLIGHT_UNIQUE_INDEX || Boolean(e.message?.includes(IN_FLIGHT_UNIQUE_INDEX));
}

async function recordRun(
  plan: Plan,
  ticket: TicketRow,
  actorId: string,
): Promise<string> {
  return withSystemContext(async (sql) => {
    // TWO layers, both required, neither redundant.
    //
    // Layer 1 (here): a conditional insert rather than check-then-insert. A double-clicked
    // "Provision" button would otherwise start two runs against the same identity — two TAPs,
    // two licence assignments, duplicate group adds. Retrying a FINISHED run is expected and
    // still allowed (history is never overwritten); only a run still in flight blocks a new one.
    // This is the fast, friendly path: it returns a clean 409 without raising a database error.
    //
    // Layer 2 (migration 0057): a partial unique index on (ticket_id) WHERE status is in flight.
    // Under READ COMMITTED two truly concurrent requests can BOTH evaluate NOT EXISTS before
    // either commits, so layer 1 alone is statistical, not structural. The index makes the
    // second insert fail with a unique violation, which is translated below into exactly the
    // same 409 — the two paths are indistinguishable to the caller, and no raw database error
    // ever reaches the client.
    let rows: any[];
    try {
      ({ rows } = await sql.query(
        `INSERT INTO provisioning_runs (ticket_id, organization_id, status, plan, started_by, started_at)
         SELECT $1,$2,'running',$3::jsonb,$4, now()
          WHERE NOT EXISTS (
            SELECT 1 FROM provisioning_runs WHERE ticket_id = $1 AND status = ANY($5)
          )
         RETURNING id`,
        [ticket.id, ticket.organization_id, JSON.stringify(plan), actorId, [...IN_FLIGHT_RUN_STATUSES]],
      ));
    } catch (err) {
      if (isInFlightUniqueViolation(err)) {
        throw Errors.conflict('a provisioning run is already in progress for this ticket');
      }
      throw err;
    }
    if (!rows[0]) throw Errors.conflict('a provisioning run is already in progress for this ticket');
    const runId: string = rows[0].id;
    for (const [i, step] of plan.steps.entries()) {
      // organization_id is denormalized onto the step: RLS is not inherited through the
      // foreign key to the run, so the column is NOT NULL and must be supplied here.
      await sql.query(
        `INSERT INTO provisioning_steps (run_id, organization_id, step_key, position)
         VALUES ($1,$2,$3,$4)`,
        [runId, ticket.organization_id, step.key, i],
      );
    }
    return runId;
  });
}

async function recordOutcomes(
  runId: string,
  outcomes: StepOutcome[],
  status: 'succeeded' | 'failed' | 'awaiting_cloudpc',
): Promise<void> {
  await withSystemContext(async (sql) => {
    for (const o of outcomes) {
      await sql.query(
        `UPDATE provisioning_steps
            SET status = $3, graph_object_id = $4, error = $5,
                attempts = attempts + 1,
                started_at = COALESCE(started_at, now()),
                finished_at = now()
          WHERE run_id = $1 AND step_key = $2`,
        [runId, o.key, o.status, o.graphObjectId ?? null, o.error ?? null],
      );
    }
    if (status === 'failed') {
      // The executor stops at the first failure, so later steps were never attempted. Leaving
      // them 'pending' would read as "still running" forever; 'skipped' says what happened.
      await sql.query(
        `UPDATE provisioning_steps SET status = 'skipped' WHERE run_id = $1 AND status = 'pending'`,
        [runId],
      );
    }
    await sql.query(
      `UPDATE provisioning_runs
          SET status = $2, error = $3,
              finished_at = CASE WHEN $2 = 'awaiting_cloudpc' THEN NULL ELSE now() END
        WHERE id = $1`,
      [runId, status, outcomes.find((o) => o.error)?.error ?? null],
    );
  });
}

/**
 * Notes the run's outcome on the ticket as an internal comment — the same shape the Cloud PC
 * poller uses when it later finishes the run, so the ticket reads as one continuous story.
 * Best-effort: the run has already been recorded by the time this is called, and failing to
 * write a note must not turn a completed run into an error.
 */
async function noteRunOutcome(
  ticket: TicketRow,
  actorId: string,
  status: string,
  outcomes: StepOutcome[],
): Promise<void> {
  const lines = [`Provisioning run ${status}: ${outcomes.map((o) => `${o.key}=${o.status}`).join(', ')}`];
  // A skipped issue_tap means the account exists and is licensed but NOBODY CAN SIGN INTO IT.
  // That cannot be left implicit in a comma-separated list of step verdicts next to the word
  // "succeeded" — the ticket is the place a human finds out they have work left to do.
  if (outcomes.some((o) => o.key === 'issue_tap' && o.status === 'skipped')) {
    lines.push('', TAP_SKIPPED_NOTICE);
  }
  const body = lines.join('\n');
  try {
    await withSystemContext(async (sql) => {
      await sql.query(
        `INSERT INTO ticket_comments (organization_id, ticket_id, author_id, visibility, body)
         VALUES ($1,$2,$3,'internal',$4)`,
        [ticket.organization_id, ticket.id, actorId, body],
      );
    });
  } catch (err) {
    logger.warn({ err, ticketId: ticket.id }, 'failed to write provisioning outcome note');
  }
}

/**
 * Executes the plan.
 *
 * `approvedFingerprint` is the value `preview` returned for the plan the admin actually read
 * and approved. It is REQUIRED. The plan is rebuilt here through the same buildPlan() as
 * preview — that has not changed — and then checked against that fingerprint, so a plan whose
 * inputs moved underneath the admin (an edit to the ticket's answers or its PII, a group
 * renamed or deleted in the tenant, a licence pool exhausted, a Cloud PC policy reassigned) is
 * REFUSED rather than executed under an approval that was given for something else.
 *
 * An absent fingerprint is refused too, and deliberately not treated as "no preference": every
 * write this function performs is irreversible against a live federal directory, and consent
 * has to be something the caller demonstrably gave.
 *
 * Order of refusals, all before any run row or tenant write:
 *   feature enabled -> permission -> right tenant org -> approved onboarding request ->
 *   fingerprint matches -> plan carries no blockers.
 */
export async function provision(
  actor: Principal,
  ticketId: string,
  approvedFingerprint?: string,
): Promise<{ runId: string; status: string; outcomes: StepOutcome[] }> {
  const { plan, ticket } = await buildPlan(actor, ticketId);
  await requireApprovedOnboardingRequest(ticket);

  if (!approvedFingerprint) {
    throw Errors.badRequest(
      'a previewed plan fingerprint is required to provision; preview the plan and approve it first',
    );
  }
  const current = planFingerprint(plan);
  if (current !== approvedFingerprint) {
    throw Errors.preconditionFailed(
      'the provisioning plan has changed since it was previewed; review the new preview and '
      + 'approve it before provisioning',
    );
  }

  if (plan.blockers.length) {
    throw Errors.badRequest(
      `plan has ${plan.blockers.length} blocker(s): ${plan.blockers.map((b) => b.message).join(' ')}`,
    );
  }

  const g = await getProvisioningGraph();
  const runId = await recordRun(plan, ticket, actor.id);

  let outcomes: StepOutcome[] = [];
  let status: 'succeeded' | 'failed' | 'awaiting_cloudpc' = 'failed';
  try {
    ({ outcomes, status } = await executePlan(plan, buildOps(g, ticket.organization_id)));
  } catch (err) {
    // executePlan only throws for a refused plan (blockers) — but if it ever throws for any
    // other reason, the run row must not be left claiming 'running' forever.
    //
    // The stored text is a FIXED string, never err.message. This path is by definition the one
    // whose error content this code does not control (the executor redacts the secrets it holds,
    // but an unexpected throw from anywhere else carries whatever text it likes), and
    // provisioning_runs.error is read back into the UI. Same class as the TAP-in-an-error-message
    // leak already closed in the executor: the detail goes to the log, which is not a data sink
    // the way a run row is.
    logger.error({ err, runId, ticketId }, 'provisioning run aborted with an unexpected error');
    outcomes = [];
    status = 'failed';
    await recordOutcomes(runId, outcomes, status);
    await withSystemContext(async (sql) => {
      await sql.query('UPDATE provisioning_runs SET error = $2 WHERE id = $1', [
        runId,
        'the provisioning run stopped with an unexpected error; see the server log for details',
      ]);
    });
    throw err;
  }

  await recordOutcomes(runId, outcomes, status);
  await noteRunOutcome(ticket, actor.id, status, outcomes);

  // Org-scoped like every other audited action here: an org-NULL row would orphan the record
  // of a directory write. `detail` carries the step verdicts and the UPN — never the TAP, never
  // the generated password, never any answer from the sensitive bag.
  await audit(actor, {
    action: 'provisioning.executed',
    organizationId: ticket.organization_id,
    resourceType: 'ticket',
    resourceId: ticketId,
    detail: {
      runId,
      status,
      upn: plan.upn,
      steps: outcomes.map((o) => ({ key: o.key, status: o.status })),
    },
  });

  return { runId, status, outcomes };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function ticketOrgFor(sql: Sql, ticketId: string): Promise<string> {
  const { rows } = await sql.query('SELECT organization_id FROM tickets WHERE id = $1', [ticketId]);
  if (!rows[0]) throw Errors.notFound('ticket not found');
  return rows[0].organization_id as string;
}

/**
 * Run history for a ticket, newest first, each with its steps in plan order.
 *
 * Caller-scoped (RLS applies) rather than system context: this is a user-facing read, and the
 * runs table doubles as the compliance record of what was done to the directory. Deliberately
 * NOT gated on config.provisioning.enabled — turning the feature off must not erase the
 * history of what it did while it was on. With no runs, it simply returns [].
 */
export async function listRuns(actor: Principal, ticketId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const organizationId = await ticketOrgFor(sql, ticketId);
    authorize(actor, 'provisioning.execute', { organizationId });
    const { rows: runs } = await sql.query(
      `SELECT id, ticket_id, organization_id, status, plan, started_by, started_at, finished_at, error, created_at
         FROM provisioning_runs WHERE ticket_id = $1 ORDER BY created_at DESC`,
      [ticketId],
    );
    if (runs.length === 0) return [];
    const { rows: steps } = await sql.query(
      `SELECT run_id, step_key, position, status, graph_object_id, error, attempts, started_at, finished_at
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
 * The organization that OWNS the provisioning tenant, matched on organizations.entra_tenant_id
 * (migration 0027) = config.provisioning.tenantId. Null when no organization claims that tenant.
 *
 * This is what gives the policy list an org to be scoped to. Without it, `ticket.create` is an
 * org-agnostic check (the PDP treats a null organizationId as "org-agnostic resource" and skips
 * the scope test), so in the multi-org model any requester in any customer org could enumerate
 * this tenant's Cloud PC policy names.
 */
async function provisioningOrganizationId(): Promise<string | null> {
  // entra_tenant_id is a uuid column; a non-uuid configured tenant id must not reach it as a
  // cast error. It also cannot match anything, so there is nothing to scope to.
  if (!UUID_RE.test(config.provisioning.tenantId)) return null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT id FROM organizations WHERE entra_tenant_id = $1',
      [config.provisioning.tenantId],
    );
    return (rows[0]?.id as string | undefined) ?? null;
  });
}

/**
 * Cloud PC provisioning policy names, for the `cloud_pc_policy` picker on the onboarding form
 * (form_fields.options_source = 'cloudpc_policies').
 *
 * Gated on `ticket.create` — the same permission that opens the form these options belong to —
 * rather than on `provisioning.execute`, which only SuperAdmin/ServiceDeskManager hold; gating
 * an option list on the execute permission would leave the picker empty for exactly the people
 * who fill the form in. But it is `ticket.create` SCOPED TO THE ORGANIZATION THAT OWNS THE
 * PROVISIONING TENANT, so a requester in some other customer org cannot enumerate this tenant's
 * policy names just by holding a permission every requester holds.
 *
 * Returns [] when provisioning is disabled, or when no organization claims the tenant, instead
 * of raising: this is an options provider, and with no tenant to enumerate the honest answer is
 * "no dynamic options" — the field then falls back to its static list, and an empty constant
 * discloses nothing. The action routes (preview/execute) refuse loudly instead.
 */
export async function listCloudPcPolicies(actor: Principal): Promise<string[]> {
  if (!config.provisioning.enabled) return [];
  const organizationId = await provisioningOrganizationId();
  if (!organizationId) return [];
  authorize(actor, 'ticket.create', { organizationId });
  const g = await getProvisioningGraph();
  const res = await g.cloudPc.get(
    '/deviceManagement/virtualEndpoint/provisioningPolicies?$select=id,displayName',
  );
  return normalizePolicies(res).map((p) => p.displayName).filter(Boolean);
}
