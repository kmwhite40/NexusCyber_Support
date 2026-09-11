// Graph operations for user provisioning against the SBS Federal tenant. Pure normalizers are
// exported separately so the planner (a later task) can be tested with no network — see
// docs/nexus/06-notifications-m365.md and the SDD onboarding-provisioning task series.
//
// This module never constructs a Graph client itself and does nothing at import time: callers
// (the provisioning runtime/planner) own building the client(s) from config.provisioning +
// the cloud_environments table, the same source of truth apps/api/src/integrations/m365/runtime.ts
// uses for the mail integration. That keeps this module inert whenever config.provisioning.enabled
// is false, and keeps the Graph endpoint (which differs per cloud: commercial / GCC / GCC High /
// Azure Gov) out of this file entirely.
import { GraphError, type GraphClient } from './graph-client.js';
import { logger } from '../../logger.js';

export interface SubscribedSku { skuId: string; skuPartNumber: string; enabled: number; consumed: number }
export interface CloudPcPolicy { id: string; displayName: string; groupIds: string[] }
export interface TenantState {
  skus: SubscribedSku[];
  policies: CloudPcPolicy[];
  /**
   * Is the Temporary Access Pass authentication method enabled in this tenant?
   *
   * `undefined` means UNKNOWN — the policy could not be read (no Policy.Read.All, or the object
   * is not reachable in this cloud). Unknown is deliberately not the same as `false`: pre-skipping
   * on a failed read would silently stop issuing credentials in a tenant where TAP works fine.
   * Only an explicit `false` pre-skips; unknown falls through to the executor's error path.
   */
  tapEnabled?: boolean;
}

/** The TAP entry of /policies/authenticationMethodsPolicy, or undefined if unreadable. */
export function normalizeTapEnabled(res: any): boolean | undefined {
  const cfgs = res?.authenticationMethodConfigurations;
  if (!Array.isArray(cfgs)) return undefined;
  const tap = cfgs.find((c: any) => String(c?.id ?? '').toLowerCase() === 'temporaryaccesspass');
  if (!tap || typeof tap.state !== 'string') return undefined;
  return tap.state.toLowerCase() === 'enabled';
}

export function normalizeSkus(res: any): SubscribedSku[] {
  return (res?.value ?? []).map((s: any) => ({
    skuId: s.skuId,
    skuPartNumber: s.skuPartNumber,
    enabled: s.prepaidUnits?.enabled ?? 0,
    consumed: s.consumedUnits ?? 0,
  }));
}

export function normalizePolicies(res: any): CloudPcPolicy[] {
  return (res?.value ?? []).map((p: any) => ({
    id: p.id,
    displayName: p.displayName,
    groupIds: (p.assignments ?? []).map((a: any) => a?.target?.groupId).filter(Boolean),
  }));
}

/**
 * Reads the tenant-wide state the provisioning planner needs: available license seats and
 * Cloud PC provisioning policies (with their assignment groups). `/subscribedSkus` is a v1.0
 * endpoint; the `/deviceManagement/virtualEndpoint/*` family currently requires the `beta`
 * Graph API version (see graph-client.ts's `apiVersion` option, added in Task 8). Rather than
 * this module choosing a version internally, the caller passes two already-configured clients
 * — `g` on v1.0, `policyBeta` on beta — so the version choice stays with whoever builds the
 * client from config, and this module stays a pure pass-through.
 */
export async function readTenantState(g: GraphClient, policyBeta: GraphClient): Promise<TenantState> {
  const [skus, policies, tap] = await Promise.all([
    g.get('/subscribedSkus'),
    policyBeta.get('/deviceManagement/virtualEndpoint/provisioningPolicies?$expand=assignments'),
    // Reading the TAP policy must never fail the whole tenant read: it needs Policy.Read.All,
    // which is an ADDITION to the design's standing permission list, so a tenant that has not
    // granted it should still be able to plan a run. An unreadable policy is UNKNOWN, and unknown
    // falls through to the executor's existing error path rather than pre-skipping.
    // ...but "could not read it" must not look like "read it and learned nothing". Without this
    // line a tenant whose app registration lacks Policy.Read.All reports exactly what a healthy
    // tenant with an indeterminate policy reports, and the guard that exists to pre-skip issue_tap
    // silently never runs — which is how a run reached Graph blind and failed after the account
    // was already written.
    g.get('/policies/authenticationMethodsPolicy').catch((err) => {
      logger.warn(
        { status: (err as { status?: number })?.status, code: graphErrorCode(err) },
        'Temporary Access Pass policy is unreadable (Policy.Read.All not granted?); '
          + 'issue_tap cannot be pre-skipped and will be attempted blind',
      );
      return null;
    }),
  ]);
  return {
    skus: normalizeSkus(skus),
    policies: normalizePolicies(policies),
    tapEnabled: normalizeTapEnabled(tap),
  };
}

/**
 * Escapes a value for use inside a single-quoted OData string literal by doubling embedded
 * single quotes (the OData ABNF escape: SQUOTE-SQUOTE), per the same rule Graph's own docs use
 * for `$filter`. `encodeURIComponent` alone does NOT do this — it leaves `'` unescaped — so a
 * UPN containing a quote (e.g. `o'brien@x.gov`) would otherwise terminate the string literal
 * early and let the rest of the value be interpreted as filter syntax.
 */
function odataStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * $select MUST list every field a caller reads. Graph silently omits anything unselected, so a
 * short list does not fail — it returns `undefined` and the caller quietly reasons about nothing.
 * The offboarding planner reads displayName/accountEnabled (to detect an already-offboarded
 * account) and givenName/surname (to build the rename), and all four were missing here.
 */
export async function findUserByUpn(g: GraphClient, upn: string) {
  const filter = `userPrincipalName eq ${odataStringLiteral(upn)}`;
  const select = 'id,userPrincipalName,displayName,accountEnabled,givenName,surname,usageLocation';
  const res = await g.get(`/users?$filter=${encodeURIComponent(filter)}&$select=${select}`);
  return res?.value?.[0] ?? null;
}

/** Non-zero means the account holds a directory role — never adopt or modify it. */
export async function directoryRoleCount(g: GraphClient, userId: string): Promise<number> {
  const res = await g.get(`/users/${userId}/memberOf/microsoft.graph.directoryRole?$select=id`);
  return (res?.value ?? []).length;
}

export async function createUser(g: GraphClient, body: Record<string, unknown>) {
  return g.post('/users', body);
}

/**
 * Graph refuses assignLicense outright for a user with no usageLocation:
 *   400 Request_BadRequest "License assignment cannot be done for user with invalid usage location."
 * It is set at creation, but an account created before that fix (or by hand) needs back-filling,
 * or every licence assignment against it fails forever.
 */
export async function patchUser(g: GraphClient, userId: string, patch: Record<string, unknown>) {
  return g.patch(`/users/${userId}`, patch);
}

/**
 * Sets a temporary password on an existing account, to be changed at next sign-in — the
 * alternative to a Temporary Access Pass, and the same thing the Entra admin centre does.
 *
 * Unlike the password written at creation (random, discarded unread), this value IS delivered,
 * which is what makes `forceChangePasswordNextSignIn` satisfiable here: Entra asks for the
 * current password before accepting a new one, and with this flow the new starter has it.
 */
export async function setPassword(g: GraphClient, userId: string, password: string) {
  return g.patch(`/users/${userId}`, {
    passwordProfile: { password, forceChangePasswordNextSignIn: true },
  });
}

export async function assignLicenses(g: GraphClient, userId: string, skuIds: string[]) {
  return g.post(`/users/${userId}/assignLicense`, {
    addLicenses: skuIds.map((skuId) => ({ skuId, disabledPlans: [] })),
    removeLicenses: [],
  });
}

export async function userLicenseSkuIds(g: GraphClient, userId: string): Promise<string[]> {
  const res = await g.get(`/users/${userId}/licenseDetails?$select=skuId`);
  return (res?.value ?? []).map((l: any) => l.skuId);
}

/**
 * Is this Graph failure "that object is already a member of that group"?
 *
 * HOW THIS CONDITION WAS IDENTIFIED. Graph has no "add if absent" verb for
 * `POST /groups/{id}/members/$ref`; a duplicate reference is rejected, not absorbed. It is
 * reported as an HTTP 400 whose payload carries the generic directory code
 * `Request_BadRequest` and the message "One or more added object references already exist for
 * the following modified properties: 'members'." That message is generated by the directory
 * (not localised for app-only tokens), which makes it the only part of the response that
 * actually distinguishes this condition — the STATUS is shared with every other bad request
 * and the CODE is shared with malformed bodies, bad `@odata.id` hosts and invalid GUIDs alike.
 *
 * So the match is deliberately BOTH halves and no looser:
 *  - status 400, AND
 *  - the body names an already-existing reference.
 *
 * It is tolerant about how that phrase is worded — case-insensitive, and "already exist" vs
 * "already exists" vs "already a member" all match — because the wrapping sentence has been
 * reworded by Microsoft before and none of those variants means anything else. It is NOT
 * tolerant about the code alone: accepting every `Request_BadRequest` would let a genuinely
 * failed group add report success, which is the exact failure the executor's
 * "refusing to silently skip group membership" guard exists to prevent. Anything this function
 * cannot positively identify stays a failure.
 *
 * Not verified against the live SBS GCC High tenant — this ships dark, and the tenant-side
 * probe is the same one the spec's open items already schedule.
 */
export function isAlreadyMemberError(err: unknown): boolean {
  if (!(err instanceof GraphError) || err.status !== 400) return false;
  return /already\s+exist|already\s+a\s+member/i.test(err.body ?? '');
}

/**
 * Adds a user to a group via a directoryObjects `@odata.id` reference. The host in that
 * reference MUST match the Graph endpoint the caller is actually authenticated against — it
 * differs per cloud (graph.microsoft.com for commercial/GCC, graph.microsoft.us for GCC
 * High/Azure Gov). `graphEndpoint` is therefore a required parameter, sourced by the caller
 * from the same `cloud_environments` row (keyed by `config.provisioning.cloud`) used to build
 * `g` in the first place — never a hardcoded host in this module.
 *
 * IDEMPOTENT BY ADOPTION. "Completed steps adopt existing objects" is the guarantee the whole
 * retry story rests on, and an unconditional POST broke it for group membership specifically:
 * a run that failed at `issue_tap` (or anywhere after `add_groups`) could not be retried,
 * because the retry hit the duplicate-reference 400 AT `add_groups` and stopped there — before
 * reaching the step that actually needed re-running. An existing membership is the state this
 * step wants, so it is success, exactly as `create_user` treats an existing account.
 */
export async function addToGroup(g: GraphClient, groupId: string, userId: string, graphEndpoint: string) {
  const base = graphEndpoint.replace(/\/+$/, '');
  try {
    return await g.post(`/groups/${groupId}/members/$ref`, {
      '@odata.id': `${base}/v1.0/directoryObjects/${userId}`,
    });
  } catch (err) {
    if (!isAlreadyMemberError(err)) throw err;
    // Ids only — a group id and a directory object id are not secrets, and nothing from the
    // Graph error body (which echoes the request) is logged.
    logger.info({ groupId, userId }, 'group membership already present; adopting it');
    return null;
  }
}

/**
 * Sets the user's manager.
 *
 * The manager is a single-valued REFERENCE, not a property: PUT /users/{id}/manager/$ref with an
 * `@odata.id` naming the manager's directory object. As with addToGroup, the host in that
 * reference must match the endpoint this client authenticated against — graph.microsoft.us in
 * GCC High — so `graphEndpoint` is a required parameter sourced from the same cloud_environments
 * row the client was built from, never a literal in this module.
 *
 * PUT replaces, so this is idempotent: running it again against the same manager is a no-op, and
 * a retry after a partial run does not need to know whether the first attempt landed.
 */
export async function setManager(
  g: GraphClient, userId: string, managerObjectId: string, graphEndpoint: string,
) {
  const base = graphEndpoint.replace(/\/+$/, '');
  return g.put(`/users/${userId}/manager/$ref`, {
    '@odata.id': `${base}/v1.0/directoryObjects/${managerObjectId}`,
  });
}

/**
 * Is this Graph failure "the tenant has no Temporary Access Pass policy enabled"?
 *
 * Spec open item #4 defines the fallback for this exact tenant state: `issue_tap` is marked
 * SKIPPED and the rest of the run is unaffected. Without a way to recognise it, a tenant that
 * has never turned the TAP authentication method on fails the run AFTER the account, the
 * licences and the group memberships are already written — the worst possible place to stop.
 *
 * Entra reports it on `POST /users/{id}/authentication/temporaryAccessPassMethods` as a 400 or
 * 403 whose message says the Temporary Access Pass method is not enabled / is disabled / is not
 * allowed for the tenant or the user. As with isAlreadyMemberError above, the status alone
 * cannot carry the meaning, so the message must name BOTH the method and the not-enabled
 * condition. Anything else — including a plain 403 from a missing app permission, which must
 * NOT be silently downgraded to "skipped" — stays a failure and fails the run.
 */
export function isTapPolicyDisabledError(err: unknown): boolean {
  if (!(err instanceof GraphError)) return false;
  if (err.status !== 400 && err.status !== 403) return false;
  const body = err.body ?? '';
  const namesTap = /temporary\s*access\s*pass|temporaryaccesspass/i.test(body);
  const notEnabled = /not\s+enabled|disabled|not\s+allowed|is\s+off\b/i.test(body);
  return namesTap && notEnabled;
}


/**
 * Graph's `error.code` for a failed request, or undefined when there isn't one.
 *
 * The TAP adapter keeps the Graph response away from its error path on purpose: a request that
 * fails AFTER Graph has minted a pass would otherwise carry that pass out in the message. That
 * reasoning is sound for the response, and it swallowed the error payload along with it — which
 * is how a production run came back saying only "Graph 404", with no way to tell a user the
 * authentication-methods service cannot resolve yet from a segment this cloud does not serve.
 *
 * Only `code` is taken, never `message`: the code is a label from Graph's fixed vocabulary, while
 * the message routinely echoes request content, and this value ends up on a ticket.
 */
export function graphErrorCode(err: unknown): string | undefined {
  if (!(err instanceof GraphError)) return undefined;
  try {
    const code = JSON.parse(err.body ?? '')?.error?.code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

export interface MirrorGroup { id: string; displayName: string }

export interface MirrorPartition {
  /** Safe to copy: ordinary security groups and distribution lists. */
  assignable: MirrorGroup[];
  /** Groups that can carry a directory role. Never copied silently — the approver must see them. */
  roleAssignable: MirrorGroup[];
  /** Dynamic groups. Graph refuses a manual add, so attempting one fails the run. */
  dynamic: MirrorGroup[];
  /** Directory roles. Never mirrored under any circumstance. */
  directoryRoles: MirrorGroup[];
}

/**
 * Sort a mirror user's memberships into what may be copied and what may not.
 *
 * Copying access is not one action. The mirror user's memberships include things a new starter
 * must not inherit by side effect:
 *
 *  - DIRECTORY ROLES are never mirrored. Copying a role because someone typed a colleague's name
 *    into a form field is not a decision anyone made.
 *  - ROLE-ASSIGNABLE GROUPS are held back for acknowledgement. mike.rohan really does hold
 *    SBS_Dev_Users (isAssignableToRole=true) among 23 groups; a silent copy hands a new hire a
 *    group that can carry a directory role, approved by someone who read "copy access from Mike"
 *    rather than the list of what Mike actually holds.
 *  - DYNAMIC GROUPS cannot take manual members at all. Graph rejects the add, and the failure
 *    reads like a permissions problem rather than a category error.
 */
export function partitionMirrorGroups(memberOf: Array<Record<string, unknown>>): MirrorPartition {
  const out: MirrorPartition = { assignable: [], roleAssignable: [], dynamic: [], directoryRoles: [] };
  for (const m of memberOf ?? []) {
    const entry: MirrorGroup = { id: String(m.id ?? ''), displayName: String(m.displayName ?? '') };
    const type = String(m['@odata.type'] ?? '');
    if (type.endsWith('directoryRole')) { out.directoryRoles.push(entry); continue; }
    if (m.membershipRule) { out.dynamic.push(entry); continue; }
    if (m.isAssignableToRole === true) { out.roleAssignable.push(entry); continue; }
    out.assignable.push(entry);
  }
  return out;
}

/**
 * Every group in the tenant a requester may pick from, paged to the end.
 *
 * "Security / distribution groups" used to be a free-text box: names were typed from memory, and
 * a mistyped one became a group_missing blocker after approval — or, far more often, the box was
 * left empty and the hire got no groups at all.
 *
 * PAGING IS THE POINT. /groups returns 100 rows by default and at most 999, and a "list them all"
 * that ignores @odata.nextLink silently truncates in a large tenant — reporting a group that IS
 * present as absent, which is the same class of bug as the name matching this module already
 * guards against. When the page ceiling is reached the result SAYS it is short rather than
 * looking complete; the caller surfaces that instead of pretending the list is the whole tenant.
 *
 * Dynamic groups are left out: Graph refuses a manual add to one, so offering it is offering a
 * run that fails at add_groups. Role-assignable groups stay — picking one from a list is a
 * deliberate act by someone reading it, unlike the mirror flow, where they are copied sight
 * unseen and therefore held back as a blocker.
 */
export async function listSelectableGroups(
  g: GraphClient,
  opts: { maxPages?: number } = {},
): Promise<{ groups: DirectoryGroup[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? 20; // 20 x 999 — far past any tenant this serves
  const groups: DirectoryGroup[] = [];
  let path: string | null =
    '/groups?$select=id,displayName,membershipRule,isAssignableToRole,groupTypes&$top=999';
  let pages = 0;
  let truncated = false;
  while (path) {
    if (pages >= maxPages) { truncated = true; break; }
    const res: any = await g.get(path);
    pages += 1;
    for (const raw of res?.value ?? []) {
      // A group with no id cannot be joined and one with no name cannot be shown or matched, so
      // neither belongs in a list whose whole purpose is choosing by name.
      if (typeof raw?.id !== 'string' || typeof raw?.displayName !== 'string') continue;
      if (raw.membershipRule) continue;
      groups.push({ id: raw.id, displayName: raw.displayName });
    }
    const next: unknown = res?.['@odata.nextLink'];
    // The client takes paths, not absolute URLs; nextLink is absolute, so keep what follows the
    // API version segment.
    path = typeof next === 'string' && next ? next.replace(/^.*\/(?:v1\.0|beta)/, '') : null;
  }
  return { groups, truncated };
}

/** Every group and directory role a user belongs to, for the mirror-access flow. */
export async function listMemberOf(g: GraphClient, userId: string): Promise<Array<Record<string, unknown>>> {
  // $select must name isAssignableToRole and membershipRule — Graph omits unselected fields
  // silently, and without them every group would look ordinary and copyable.
  const res = await g.get(
    `/users/${encodeURIComponent(userId)}/memberOf`
    + '?$select=id,displayName,membershipRule,isAssignableToRole,groupTypes,securityEnabled,mailEnabled',
  );
  return (res?.value ?? []) as Array<Record<string, unknown>>;
}

/**
 * Issues a Temporary Access Pass, retrying only while the account is still catching up.
 *
 * A production run failed with a Graph 404 here after create_user and assign_licenses had both
 * succeeded against that same user id. Probing the live GCC High tenant settled which 404 it was:
 * a GET on the same segment for an ESTABLISHED user returns 200, so v1.0 serves it in this cloud
 * — the account was simply too new. `/users/{id}/authentication/*` is backed by the
 * authentication-methods service, a different store from the directory, and it can still 404 for
 * a user the directory already answers for.
 *
 * ONLY 404 IS RETRIED HERE, and that restriction is the safety property rather than a tidiness
 * choice. A 404 means Graph created nothing, so another attempt cannot mint a second pass. A
 * dropped connection says the opposite — the request may well have succeeded server-side — and
 * retrying that would put a second live credential into the tenant with nobody holding it. A
 * 400/403 is an answer about policy or permission, not about timing; delaying it helps no one.
 * All of those still fail the run exactly as before.
 *
 * Note what this does NOT cover: graph-client.ts retries 429 and 503 underneath this function,
 * for every call it makes. A 429 is safe — Graph rejected the request without processing it. A
 * 503 is the one case where a pass could in principle have been minted before the retry, and
 * this wrapper cannot see it happen. Left as it is deliberately: suppressing it would need a
 * per-call opt-out on the client, and 503 on a single write almost certainly means the write did
 * not land. Worth revisiting if a duplicate pass is ever actually observed.
 */
export async function issueTap(
  g: GraphClient,
  userId: string,
  lifetimeInMinutes: number,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Single-use regardless of lifetime. A longer window widens the time a pass is live, so
      // one-shot use is what keeps a 7-day pass from being a 7-day standing credential.
      return await g.post(`/users/${userId}/authentication/temporaryAccessPassMethods`, {
        isUsableOnce: true, lifetimeInMinutes,
      });
    } catch (err) {
      lastErr = err;
      if (!(err instanceof GraphError) || err.status !== 404 || attempt === attempts) throw err;
      // 2s, 4s, 8s, 16s — ~30s in total, which is the order replication actually takes. Longer
      // would hold a run open for a user who is genuinely never going to appear.
      const waitMs = 2000 * 2 ** (attempt - 1);
      logger.warn(
        { userId, attempt, waitMs },
        'Temporary Access Pass 404 — the account may not have replicated to the '
          + 'authentication-methods service yet; retrying',
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

/**
 * Looks up a user's Cloud PC status by `userPrincipalName`, the actual field the cloudPC
 * resource is filterable on. The brief named this parameter `userId`, but nothing here ever
 * accepts or filters on a directory object id — it is a UPN — so the parameter is named `upn`
 * to say what it is.
 */
export async function getCloudPcStatus(g: GraphClient, upn: string): Promise<string | null> {
  const filter = `userPrincipalName eq ${odataStringLiteral(upn)}`;
  const res = await g.get(`/deviceManagement/virtualEndpoint/cloudPCs?$filter=${encodeURIComponent(filter)}`);
  return res?.value?.[0]?.status ?? null;
}

export interface DirectoryGroup { id: string; displayName: string }

/** Pure. Reduces a `/groups` payload to id/displayName pairs, dropping any entry missing
 *  either half — a group with no id cannot be joined and one with no name cannot be matched
 *  against the request form's free-text group list, so neither belongs in the lookup table. */
export function normalizeGroups(res: any): DirectoryGroup[] {
  return (res?.value ?? [])
    .filter((g: any) => typeof g?.id === 'string' && typeof g?.displayName === 'string')
    .map((g: any) => ({ id: g.id, displayName: g.displayName }));
}

/**
 * Looks up directory groups BY NAME, server-side, rather than enumerating every group in the
 * tenant and filtering locally: `/groups` pages at 100-999 rows, so a "list them all" approach
 * silently truncates in a large tenant and would report a perfectly real group as missing.
 * Filtering by the handful of names the request actually asked for has no pagination to get
 * wrong. Names are chunked because an OData `$filter` is a URL, and a URL has a length limit.
 *
 * Graph compares directory string properties case-insensitively, and the caller matches
 * case-insensitively again over the result, so the admin's capitalization does not matter.
 * Names that match nothing simply do not come back — the caller turns that into a blocker.
 */
export async function listGroupsByDisplayName(
  g: GraphClient,
  names: string[],
  chunkSize = 15,
): Promise<DirectoryGroup[]> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const out: DirectoryGroup[] = [];
  for (let i = 0; i < wanted.length; i += chunkSize) {
    const filter = wanted
      .slice(i, i + chunkSize)
      .map((n) => `displayName eq ${odataStringLiteral(n)}`)
      .join(' or ');
    const res = await g.get(`/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`);
    out.push(...normalizeGroups(res));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Offboarding operations
// ---------------------------------------------------------------------------
// The destructive counterparts to createUser / assignLicenses / addToGroup above. They live in
// this file because they speak to the same Graph surface through the same client, but nothing
// here is reachable from the onboarding planner or executor — see modules/offboarding/.
//
// Note what is NOT here: converting a mailbox to shared. Graph exposes no mailbox-type
// conversion endpoint; `Set-Mailbox -Type Shared` is Exchange Online PowerShell. That step is
// deliberately a prompted manual step, and the planner still refuses to emit license removal
// until it is recorded complete.

export async function setAccountEnabled(g: GraphClient, userId: string, enabled: boolean): Promise<void> {
  await g.patch(`/users/${userId}`, { accountEnabled: enabled });
}

/**
 * The supported way to kill live sessions. A password reset does NOT invalidate existing refresh
 * tokens, so an account can be "disabled" and still serving a live session until this runs —
 * which is why the planner orders this immediately after block_signin.
 */
export async function revokeSignInSessions(g: GraphClient, userId: string): Promise<void> {
  await g.post(`/users/${userId}/revokeSignInSessions`, {});
}

/** displayName ONLY. Renaming the UPN breaks mailbox resolution and muddies the audit trail. */
export async function setDisplayName(g: GraphClient, userId: string, displayName: string): Promise<void> {
  await g.patch(`/users/${userId}`, { displayName });
}

export async function removeLicenses(g: GraphClient, userId: string, skuIds: string[]): Promise<void> {
  // An assignLicense call with an empty removeLicenses array is a pointless round trip that can
  // still fail and still counts against throttling limits. Nothing to reclaim, nothing to call.
  if (skuIds.length === 0) return;
  await g.post(`/users/${userId}/assignLicense`, { addLicenses: [], removeLicenses: skuIds });
}

export async function removeFromGroup(g: GraphClient, groupId: string, userId: string): Promise<void> {
  await g.del(`/groups/${groupId}/members/${userId}/$ref`);
}

/**
 * Whether an account still exists, by object id.
 *
 * THREE-VALUED ON PURPOSE. `null` means the answer is UNKNOWN — a throttle, an outage, a
 * permissions problem — and the retention sweeper must be able to tell that from "confirmed
 * gone". Collapsing the two would either manufacture a compliance breach out of a network blip,
 * or hide a real one behind an optimistic default. Only a 404 is treated as absent.
 */
export async function accountExists(g: GraphClient, objectId: string): Promise<boolean | null> {
  try {
    const res = await g.get(`/users/${objectId}?$select=id`);
    return Boolean(res?.id);
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) return false;
    return null;
  }
}
