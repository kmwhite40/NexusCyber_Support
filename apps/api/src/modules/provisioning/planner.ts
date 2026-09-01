// Pure planner. The dry-run preview and the executor walk the SAME plan, so what the admin
// approves is exactly what runs. No I/O here — everything the plan needs is passed in via
// PlanInput. Do not add lookups (DB, Graph, config, Date.now(), randomness) to this file or to
// deriveUpn: a missing value must become a blocker, never something the planner fetches itself.
import type { TenantState } from '../../integrations/m365/provisioning-graph.js';

export type StepKey =
  | 'create_user' | 'assign_licenses' | 'add_groups'
  | 'assign_cloudpc' | 'issue_tap' | 'await_cloudpc';

export interface PlanStep { key: StepKey; label: string; detail: Record<string, unknown> }
export interface Blocker { code: string; message: string }
export interface Plan { upn: string; displayName: string; steps: PlanStep[]; blockers: Blocker[] }

export interface PlanInput {
  answers: Record<string, unknown>;
  tenant: TenantState;
  upnDomain: string;
  baselineSkus: string[];
  existingUser: { id: string; userPrincipalName: string } | null;
  existingRoleCount: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
/** UPN-safe: letters and digits only, so apostrophes, spaces, and any stray '@' can never
 *  break the local part or smuggle the identity into a different namespace. This intentionally
 *  strips diacritics (Renée -> renee) and non-Latin scripts (CJK, Cyrillic, etc.) entirely,
 *  since neither survives ASCII-only UPN local parts. A name that reduces to nothing under this
 *  transform (all-CJK, punctuation-only, ...) is NOT silently mangled into an empty segment —
 *  planRun below checks for that and refuses with a blocker. Refusing is the correct failure
 *  direction here: for identity creation, silently producing a wrong-but-valid-looking UPN is
 *  worse than stopping and asking a human to supply an ASCII-transliterated name. */
const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

export function deriveUpn(answers: Record<string, unknown>, upnDomain: string): string {
  const first = slug(str(answers.preferred_first_name) || str(answers.legal_first_name));
  const last = slug(str(answers.legal_last_name));
  return `${first}.${last}@${upnDomain}`;
}

export function planRun(input: PlanInput): Plan {
  const { answers, tenant, upnDomain, baselineSkus, existingUser, existingRoleCount } = input;
  const blockers: Blocker[] = [];
  const upn = deriveUpn(answers, upnDomain);
  const first = str(answers.preferred_first_name) || str(answers.legal_first_name);
  const displayName = [first, str(answers.legal_last_name)].filter(Boolean).join(' ');

  if (!str(answers.legal_first_name) || !str(answers.legal_last_name)) {
    blockers.push({ code: 'name_missing', message: 'Legal first and last name are required.' });
  }
  // slug() strips everything outside [a-z0-9], so a name written entirely in a non-Latin script
  // (CJK, Cyrillic, ...) or consisting only of punctuation reduces to an empty string even
  // though the raw answer above is non-empty and passes the name_missing check. Left unchecked,
  // that produces a plan to create ".@domain" or "firstname.@domain" — a real, reachable gap,
  // not the dead one below. Check the SLUGGED parts, not the raw strings.
  const firstSlug = slug(first);
  const lastSlug = slug(str(answers.legal_last_name));
  if (!firstSlug || !lastSlug) {
    const which = !firstSlug && !lastSlug ? 'first and last name' : !firstSlug ? 'first name' : 'last name';
    blockers.push({
      code: 'upn_local_part_empty',
      message: `The ${which} could not be converted to a valid UPN (only ASCII letters and digits survive transliteration).`,
    });
  }
  // Belt-and-suspenders, currently unreachable: deriveUpn always appends upnDomain literally, so
  // upn.endsWith(`@${upnDomain}`) can never be false today. This exists to catch a future change
  // to deriveUpn (e.g. reading a domain from the answers instead of the upnDomain parameter)
  // that might stop guaranteeing the domain suffix, without this planner silently missing it.
  if (!upn.endsWith(`@${upnDomain}`)) {
    blockers.push({ code: 'upn_domain', message: `UPN must be under @${upnDomain}.` });
  }
  if (existingUser && existingRoleCount > 0) {
    blockers.push({ code: 'privileged_account', message: `${upn} already exists and holds a directory role. Refusing to modify it.` });
  }

  // Resolve the baseline by SKU part number; a missing SKU or an exhausted pool fails the
  // dry run closed rather than leaving a half-licensed account behind.
  const skuIds: string[] = [];
  for (const part of baselineSkus) {
    const sku = tenant.skus.find((s) => s.skuPartNumber === part);
    if (!sku) { blockers.push({ code: 'sku_missing', message: `License ${part} is not present in the tenant.` }); continue; }
    if (sku.enabled - sku.consumed <= 0) { blockers.push({ code: 'no_seats', message: `No seats remaining for ${part}.` }); continue; }
    skuIds.push(sku.skuId);
  }

  const groups = str(answers.security_groups).split(/[,\n]/).map((g) => g.trim()).filter(Boolean);

  const policyName = str(answers.cloud_pc_policy);
  let policyGroupId: string | null = null;
  if (policyName) {
    const policy = tenant.policies.find((p) => p.displayName === policyName);
    if (!policy) blockers.push({ code: 'policy_missing', message: `Cloud PC policy "${policyName}" was not found.` });
    else if (policy.groupIds.length === 0) blockers.push({ code: 'policy_unassigned', message: `Cloud PC policy "${policyName}" has no assignment group.` });
    else policyGroupId = policy.groupIds[0];
  }

  const steps: PlanStep[] = [
    { key: 'create_user', label: `Create ${upn}`, detail: { upn, displayName, adopting: Boolean(existingUser) } },
    // skuPartNumbers is copied (not aliased to input.baselineSkus): the returned Plan must stay
    // isolated from the caller's array — a preview taken now must not change if the caller later
    // mutates the array it passed in.
    { key: 'assign_licenses', label: `Assign ${skuIds.length} license(s)`, detail: { skuIds, skuPartNumbers: [...baselineSkus] } },
  ];
  // Seam: group NAMES only. A later task (the service layer) resolves these to directory IDs
  // via Graph and writes detail.groupIds before the executor runs. The planner must not do that
  // lookup itself — that would require I/O and break the preview/execute purity guarantee.
  if (groups.length) steps.push({ key: 'add_groups', label: `Add to ${groups.length} group(s)`, detail: { groups } });
  // Licenses (pushed above) must precede Cloud PC group assignment: an unlicensed user added to
  // the provisioning policy's group yields a Cloud PC that silently never builds.
  if (policyGroupId) steps.push({ key: 'assign_cloudpc', label: `Add to Cloud PC group for "${policyName}"`, detail: { policyName, groupId: policyGroupId } });
  steps.push({ key: 'issue_tap', label: 'Issue Temporary Access Pass to supervisor', detail: { supervisor: str(answers.supervisor) } });
  if (policyGroupId) steps.push({ key: 'await_cloudpc', label: 'Wait for the Cloud PC to finish building', detail: { policyName } });

  return { upn, displayName, steps, blockers };
}
