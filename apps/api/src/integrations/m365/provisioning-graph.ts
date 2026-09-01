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
import type { GraphClient } from './graph-client.js';

export interface SubscribedSku { skuId: string; skuPartNumber: string; enabled: number; consumed: number }
export interface CloudPcPolicy { id: string; displayName: string; groupIds: string[] }
export interface TenantState { skus: SubscribedSku[]; policies: CloudPcPolicy[] }

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
  const [skus, policies] = await Promise.all([
    g.get('/subscribedSkus'),
    policyBeta.get('/deviceManagement/virtualEndpoint/provisioningPolicies?$expand=assignments'),
  ]);
  return { skus: normalizeSkus(skus), policies: normalizePolicies(policies) };
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

export async function findUserByUpn(g: GraphClient, upn: string) {
  const filter = `userPrincipalName eq ${odataStringLiteral(upn)}`;
  const res = await g.get(`/users?$filter=${encodeURIComponent(filter)}&$select=id,userPrincipalName`);
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
 * Adds a user to a group via a directoryObjects `@odata.id` reference. The host in that
 * reference MUST match the Graph endpoint the caller is actually authenticated against — it
 * differs per cloud (graph.microsoft.com for commercial/GCC, graph.microsoft.us for GCC
 * High/Azure Gov). `graphEndpoint` is therefore a required parameter, sourced by the caller
 * from the same `cloud_environments` row (keyed by `config.provisioning.cloud`) used to build
 * `g` in the first place — never a hardcoded host in this module.
 */
export async function addToGroup(g: GraphClient, groupId: string, userId: string, graphEndpoint: string) {
  const base = graphEndpoint.replace(/\/+$/, '');
  return g.post(`/groups/${groupId}/members/$ref`, {
    '@odata.id': `${base}/v1.0/directoryObjects/${userId}`,
  });
}

export async function issueTap(g: GraphClient, userId: string) {
  return g.post(`/users/${userId}/authentication/temporaryAccessPassMethods`, {
    isUsableOnce: true, lifetimeInMinutes: 480,
  });
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
