// Pure planner. The dry-run preview and the executor walk the SAME plan, so what the admin
// approves is exactly what runs. No I/O here — everything the plan needs is passed in via
// PlanInput. Do not add lookups (DB, Graph, config, Date.now(), randomness) to this file or to
// deriveUpn: a missing value must become a blocker, never something the planner fetches itself.
import { createHash } from 'node:crypto';
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
  /**
   * The Windows 365 SKU, assigned ONLY when the request asks for a Cloud PC.
   *
   * Deliberately not part of baselineSkus: a Cloud PC is not part of everyone's onboarding, and
   * an unconditional W365 licence charges a scarce, expensive seat to every hire — then blocks
   * the next one with no_seats for a licence they were never meant to receive.
   */
  cloudPcSku?: string;
  /** Two-letter country for licence eligibility. Graph rejects assignLicense without it. */
  usageLocation?: string;
  existingUser: { id: string; userPrincipalName: string } | null;
  existingRoleCount: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Normalises a value for MATCHING ONLY — never for display or storage — before comparing a
 * hand-configured or hand-typed identifier (a baseline SKU part number, a Cloud PC policy
 * display name, a group name) against what the tenant actually returns.
 *
 * This exists because of a real landmine found probing the live SBS Federal GCC High tenant:
 * `/subscribedSkus` reports the Windows 365 Cloud PC SKU as
 * `CPC_E_2C_4GB_64GB​_USGOV_GCCHIGH` (skuId 6bd7db5d-58d9-4ab9-b240-114e5f0d2e00) — a ZERO
 * WIDTH SPACE (U+200B) sits between `64GB` and `_USGOV`, invisible in any editor and impossible
 * for an operator to type. An exact-string match against a hand-configured
 * `M365_PROV_BASELINE_SKUS` value therefore fails for a SKU that IS present, and planRun's
 * `sku_missing` blocker sends the operator hunting in the wrong place. Fails closed, which is
 * the right direction, but for the wrong reason.
 *
 * Stripped: zero-width space (U+200B), zero-width non-joiner (U+200C), zero-width joiner
 * (U+200D), and zero-width no-break space / BOM (U+FEFF) — wherever they occur, not just a
 * leading BOM, since the tenant's own catalog data is the untrusted side here and there is no
 * guarantee the anomaly always lands at position 0. Surrounding whitespace is trimmed too.
 *
 * Case-folded as well, deliberately: these are catalog identifiers and directory display names,
 * not case-sensitive tokens. Folding here is consistent with the rest of this codebase's
 * treatment of the same class of comparison — resolveGroupIds (modules/provisioning/index.ts)
 * already matches group names case-insensitively because they are "free text typed on a request
 * form," and provisioning-graph.ts notes that Graph itself compares directory string properties
 * case-insensitively. A stricter, case-sensitive standard here would be a third, inconsistent
 * rule with no upside.
 *
 * MATCHING ONLY: callers must keep using the tenant's real value (invisible characters and all)
 * for anything that gets displayed to the admin or written to a plan/step detail. Silently
 * rewriting tenant data to look "clean" would make the preview lie about what Graph will
 * actually be asked to attach.
 */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;
export function normalizeForMatch(value: string): string {
  return value.replace(ZERO_WIDTH_RE, '').trim().toLowerCase();
}

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
  const { answers, tenant, upnDomain, baselineSkus, cloudPcSku, usageLocation, existingUser, existingRoleCount } = input;
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

  // An EMPTY baseline is not "no licences requested" — it is a misconfiguration, and it is the
  // one that fails OPEN: with nothing to iterate, the loop below emits no blocker and no sku id,
  // so `assign_licenses` no-ops while `assign_cloudpc` still adds the account to the Cloud PC
  // policy group. That produces a live, unlicensed federal identity whose Cloud PC silently
  // never builds — precisely the hard ordering constraint this planner exists to protect
  // (see the spec's "Tenant facts"). config.ts also refuses to report the feature `enabled`
  // with an empty baseline; this blocker is the second layer, so the misconfiguration is
  // VISIBLE in the dry run rather than only at process start.
  if (baselineSkus.length === 0) {
    blockers.push({
      code: 'baseline_empty',
      message: 'No baseline license SKUs are configured (M365_PROV_BASELINE_SKUS is empty). '
        + 'An unlicensed account added to the Cloud PC policy group never builds a Cloud PC.',
    });
  }
  // Resolve the baseline by SKU part number; a missing SKU or an exhausted pool fails the
  // dry run closed rather than leaving a half-licensed account behind. Matched via
  // normalizeForMatch (see its doc comment above) rather than `===`, so a zero-width space or
  // stray casing in either the tenant's catalog data or the hand-typed config value cannot turn
  // a SKU that IS present into a false sku_missing blocker. skuIds/skuId below still come from
  // `sku` (the tenant's real record) — only the comparison is normalised, never what gets
  // stored or shown.
  const skuIds: string[] = [];
  for (const part of baselineSkus) {
    const sku = tenant.skus.find((s) => normalizeForMatch(s.skuPartNumber) === normalizeForMatch(part));
    if (!sku) { blockers.push({ code: 'sku_missing', message: `License ${part} is not present in the tenant.` }); continue; }
    if (sku.enabled - sku.consumed <= 0) { blockers.push({ code: 'no_seats', message: `No seats remaining for ${part}.` }); continue; }
    skuIds.push(sku.skuId);
  }

  const groups = str(answers.security_groups).split(/[,\n]/).map((g) => g.trim()).filter(Boolean);

  const policyName = str(answers.cloud_pc_policy);
  let policyGroupId: string | null = null;
  if (policyName) {
    // Same normalizeForMatch reasoning as the SKU loop above: a Cloud PC provisioning policy's
    // displayName is tenant catalog/admin data, not something this planner controls, so it is
    // matched the same defensive way rather than with `===`.
    const policy = tenant.policies.find((p) => normalizeForMatch(p.displayName) === normalizeForMatch(policyName));
    if (!policy) blockers.push({ code: 'policy_missing', message: `Cloud PC policy "${policyName}" was not found.` });
    else if (policy.groupIds.length === 0) blockers.push({ code: 'policy_unassigned', message: `Cloud PC policy "${policyName}" has no assignment group.` });
    else policyGroupId = policy.groupIds[0];
  }

  // The Cloud PC licence is resolved HERE, after policyGroupId, because it is conditional on the
  // very same answer. The licence must be in skuIds before assign_cloudpc adds the account to the
  // policy group — a Cloud PC materializes only for a licensed member, and the reverse order
  // produces an account that sits in the group forever with nothing ever building.
  if (policyGroupId) {
    if (!cloudPcSku) {
      blockers.push({
        code: 'cloudpc_sku_unconfigured',
        message: 'A Cloud PC was requested but M365_PROV_CLOUDPC_SKU is not configured. '
          + 'An unlicensed account added to the Cloud PC policy group never builds a Cloud PC.',
      });
    } else {
      const sku = tenant.skus.find((s) => normalizeForMatch(s.skuPartNumber) === normalizeForMatch(cloudPcSku));
      if (!sku) blockers.push({ code: 'sku_missing', message: `License ${cloudPcSku} is not present in the tenant.` });
      else if (sku.enabled - sku.consumed <= 0) blockers.push({ code: 'no_seats', message: `No seats remaining for ${cloudPcSku}.` });
      else skuIds.push(sku.skuId);
    }
  }

  const steps: PlanStep[] = [
    {
      key: 'create_user',
      label: `Create ${upn}`,
      // givenName/surname go to Graph as their own fields. Sending only displayName forces every
      // downstream reader to guess at the split — offboarding's nameParts() does exactly that,
      // and returns a blocker when it cannot. The exact names are right here; pass them.
      // givenName tracks the same `first` displayName uses, so the two never disagree.
      detail: {
        upn, displayName, adopting: Boolean(existingUser), usageLocation,
        givenName: first, surname: str(answers.legal_last_name),
      },
    },
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
  // TAP state is read up front (see readTenantState) rather than discovered by catching an error
  // from issueTap — that discovery happens only AFTER the account, licences and group memberships
  // are written, which is the worst place for a run to stop. Marking it here puts the fact in the
  // PREVIEW, where an admin sees it before anything is created.
  //
  // Only an explicit `false` pre-skips. `undefined` means the policy could not be read, and
  // pre-skipping on that would silently stop issuing credentials in a tenant where TAP works.
  const tapDisabled = tenant.tapEnabled === false;
  steps.push({
    key: 'issue_tap',
    label: tapDisabled
      ? 'Issue Temporary Access Pass to supervisor (will be skipped)'
      : 'Issue Temporary Access Pass to supervisor',
    detail: {
      supervisor: str(answers.supervisor),
      ...(tapDisabled
        ? { willSkip: true, skipReason: 'Temporary Access Pass is disabled in this tenant; no first-sign-in credential will be issued.' }
        : {}),
    },
  });
  if (policyGroupId) steps.push({ key: 'await_cloudpc', label: 'Wait for the Cloud PC to finish building', detail: { policyName } });

  return { upn, displayName, steps, blockers };
}

// ---------------------------------------------------------------------------
// The plan fingerprint — what binds an approved preview to the run that executes
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted recursively, no whitespace.
 *
 * This is the ONLY normalisation applied. Array ORDER is preserved everywhere except the
 * blocker list (see below), because order is material almost everywhere a plan uses an array:
 * `steps` encodes the hard "licences before the Cloud PC group" ordering constraint, and a
 * future step could reasonably carry an ordered detail array too. Sorting those would let a
 * genuinely different plan hash the same — the exact failure this fingerprint exists to catch.
 * What IS normalised is the stuff that carries no meaning: property order and serialisation
 * whitespace, which differ between a plan built in memory and the same plan round-tripped
 * through JSONB.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * A stable hash of everything about a plan that determines what gets WRITTEN to the tenant.
 *
 * THIS IS THE PREVIEW GUARANTEE. `preview` returns it; `provision` re-plans from current data
 * and refuses unless the fresh plan hashes to the same value. Without it, "the plan you
 * approved is the plan that runs" was only ever a claim about the code path, not about the
 * DATA: any write to tickets.custom_fields (or the sensitive store, or the tenant's groups and
 * policies) between the two clicks silently changed the UPN, the group list and the Cloud PC
 * policy that got created, with the admin's approval still attached.
 *
 * Covered, deliberately:
 *  - `upn` and `displayName` — the identity itself;
 *  - every step, IN ORDER, by key, human-readable label, and full material detail (sku ids,
 *    resolved group ids, the Cloud PC policy group, the supervisor who receives the credential);
 *  - `blockers` — a plan that acquired a blocker between preview and execute is a DIFFERENT
 *    plan, and one an admin never approved. Blockers are sorted first because they are a set of
 *    reasons, not a sequence: two planners emitting the same reasons in a different order
 *    describe the same refusal.
 *
 * Everything in Plan is covered; there is nothing in a Plan that is not material. If a field is
 * ever added to Plan, it lands in this hash automatically — that is why this hashes the whole
 * object rather than a hand-picked projection.
 */
export function planFingerprint(plan: Plan): string {
  const canonical = {
    upn: plan.upn,
    displayName: plan.displayName,
    steps: plan.steps.map((s) => ({ key: s.key, label: s.label, detail: s.detail })),
    blockers: [...plan.blockers].sort((a, b) =>
      a.code === b.code ? (a.message < b.message ? -1 : a.message > b.message ? 1 : 0)
        : a.code < b.code ? -1 : 1),
  };
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}
