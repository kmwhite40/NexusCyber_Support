// Central configuration. Per-cloud endpoints live in the cloud_environments table
// (data, not code) — see docs/nexus/06-notifications-m365.md (Section L).

export type Enclave = 'commercial' | 'gov';

export interface Config {
  port: number;
  /** Owner/admin connection — used by migrate & seed (bypasses RLS to bootstrap). */
  adminDatabaseUrl: string;
  /** Runtime connection as a non-owner role so RLS is ENFORCED on request queries. */
  appDatabaseUrl: string;
  sessionSigningKey: string;
  webOrigin: string[];
  enclave: Enclave;
  isProduction: boolean;
  m365: M365Config;
  oidc: OidcConfig;
  oidcCustomer: OidcCustomerConfig;
  notifications: NotificationsConfig;
  retention: RetentionConfig;
  provisioning: ProvisioningConfig;
  entraSync: EntraSyncConfig;
}

export interface NotificationsConfig {
  /** Shared service-desk mailbox that receives new-ticket notifications when the
   *  owning assignment group has no notification_email of its own. */
  serviceDeskEmail: string | undefined;
}

/** Data-retention purge: permanently delete resolved incidents, problems, and changes
 *  older than `days`. A daily background job enforces this. */
export interface RetentionConfig {
  enabled: boolean;
  days: number;
}

/** Entra ID (Azure Gov) OIDC for the agent plane — see docs/nexus/artifacts/auth-entra-oidc-scope.md. */
export interface OidcConfig {
  /** Master switch. */
  enabled: boolean;
  /** True only when enabled AND authority + clientId + redirectUri are present. */
  configured: boolean;
  /** e.g. https://login.microsoftonline.us/{tenant}/v2.0 (gov, NOT .com). */
  authority: string;
  tenantId: string;
  clientId: string;
  /** Confidential-client secret; empty for a public PKCE client. */
  clientSecret: string;
  redirectUri: string;
  /** Web URL the callback redirects to with the session token in the fragment. */
  postLoginRedirect: string;
  /** App roles (e.g. Anchor.SecurityAnalyst) allowed to sign in / self-provision. Empty = allow any role the token carries. */
  allowedAppRoles: string[];
}

/**
 * Multitenant Entra OIDC for the CUSTOMER plane — external customer M365 tenants sign in
 * with their own Entra ID (see docs/nexus/artifacts/auth-entra-oidc-customer-setup.md).
 * Distinct app registration from the agent one; tokens come from many issuers, so the
 * tenant (tid) is validated against organizations.entra_tenant_id (the allow-list).
 */
export interface OidcCustomerConfig {
  enabled: boolean;
  configured: boolean;
  /** Multitenant authority, e.g. https://login.microsoftonline.us/organizations/v2.0. */
  authority: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLoginRedirect: string;
  /** Default Anchor role for a JIT-provisioned customer user. */
  defaultRoleKey: string;
}

export type M365Cloud = 'commercial' | 'gcc' | 'gcchigh' | 'azgov';

export interface M365Config {
  /** Master switch. When false, the console (dev) transport is used. */
  enabled: boolean;
  /** True only when enabled AND all credentials + mailbox are present. */
  configured: boolean;
  cloud: M365Cloud;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  serviceMailbox: string;
  ingestEnabled: boolean;
  teamsEnabled: boolean;
}

export interface ProvisioningConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  cloud: M365Cloud;
  upnDomain: string;
  baselineSkus: string[];
  cloudPcPolicy: string;
  /**
   * Windows 365 SKU, assigned ONLY to hires whose request asks for a Cloud PC. Separate from
   * baselineSkus because a Cloud PC is not part of everyone's onboarding: an unconditional W365
   * licence spends a scarce seat on every hire and then blocks the next one with no_seats.
   */
  cloudPcSku: string;
  /** Two-letter country code stamped on created users; Graph refuses licences without one. */
  usageLocation: string;
  /**
   * Graph API version for the `/deviceManagement/virtualEndpoint/*` family (Cloud PC status
   * lookups). Whether GCC High specifically requires `beta` there vs `v1.0` is an open item in
   * the onboarding-provisioning spec — unverified against the real SBS tenant — so this is a
   * config flip (M365_PROV_CLOUDPC_API_VERSION), not a source-code literal, on purpose: whoever
   * probes the tenant and gets a real answer should be able to set it here without a code change.
   * Defaults to 'beta', per the family-wide requirement documented on readTenantState in
   * integrations/m365/provisioning-graph.ts.
   */
  cloudPcApiVersion: 'v1.0' | 'beta';
  /**
   * Whether the OFFBOARDING half may run. An ADDITIONAL gate on top of `enabled`, never an
   * independent one.
   *
   * Both flows need the same tenant credentials, so offboarding must be impossible without
   * them. But a single shared flag also meant that switching on onboarding silently armed
   * account teardown — sweeper included — in the same deploy. Nobody should have to accept the
   * destructive half in order to get the constructive one, so this is ANDed with the full
   * provisioning config rather than replacing it.
   */
  offboardingEnabled: boolean;
}

const bool = (v: string | undefined): boolean => v === 'true' || v === '1';

export function parseM365Config(env: NodeJS.ProcessEnv): M365Config {
  const enabled = bool(env.M365_ENABLED);
  const tenantId = env.M365_TENANT_ID ?? '';
  const clientId = env.M365_CLIENT_ID ?? '';
  const clientSecret = env.M365_CLIENT_SECRET ?? '';
  const serviceMailbox = env.M365_SERVICE_MAILBOX ?? '';
  const configured =
    enabled && !!tenantId && !!clientId && !!clientSecret && !!serviceMailbox;
  return {
    enabled,
    configured,
    cloud: (env.M365_CLOUD as M365Cloud) ?? 'gcc',
    tenantId,
    clientId,
    clientSecret,
    serviceMailbox,
    ingestEnabled: bool(env.M365_INGEST_ENABLED),
    teamsEnabled: bool(env.M365_TEAMS_ENABLED),
  };
}

export function parseProvisioningConfig(env: NodeJS.ProcessEnv): ProvisioningConfig {
  const tenantId = env.M365_PROV_TENANT_ID ?? '';
  const clientId = env.M365_PROV_CLIENT_ID ?? '';
  const clientSecret = env.M365_PROV_CLIENT_SECRET ?? '';
  const upnDomain = (env.M365_PROV_UPN_DOMAIN ?? '').toLowerCase();
  const baselineSkus = (env.M365_PROV_BASELINE_SKUS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // Opting in is necessary but not sufficient: a half-configured app must stay dark.
  //
  // baselineSkus is part of that "configured" test, and its omission was a fail-OPEN hole rather
  // than a cosmetic one: with an empty baseline the planner's licence loop produces no blockers
  // and no sku ids, so `assign_licenses` no-ops while `assign_cloudpc` still adds the account to
  // the Cloud PC policy group — creating a live, unlicensed federal identity whose Cloud PC
  // silently never builds. That is the hard ordering constraint the whole feature exists to
  // protect, so an empty M365_PROV_BASELINE_SKUS keeps the feature dark. (The planner carries a
  // matching `baseline_empty` blocker so the same misconfiguration is also visible in a preview,
  // rather than only in whether the process started with the feature on.)
  const enabled = bool(env.M365_PROV_ENABLED)
    && Boolean(tenantId && clientId && clientSecret && upnDomain)
    && baselineSkus.length > 0;
  const rawApiVersion = env.M365_PROV_CLOUDPC_API_VERSION;
  // A garbage value must never reach the Graph client as a path segment — fall back to the
  // (verified-safe) default rather than passing it through.
  const cloudPcApiVersion: 'v1.0' | 'beta' =
    rawApiVersion === 'v1.0' || rawApiVersion === 'beta' ? rawApiVersion : 'beta';
  // AND, deliberately: no tenant configuration means no teardown, whatever this flag says.
  const offboardingEnabled = enabled && bool(env.M365_OFFBOARD_ENABLED);
  return {
    enabled, tenantId, clientId, clientSecret,
    cloud: (env.M365_PROV_CLOUD as M365Cloud) ?? 'gcchigh',
    upnDomain, baselineSkus,
    cloudPcPolicy: env.M365_PROV_CLOUDPC_POLICY ?? 'SBSFederal Cloud PC',
    cloudPcSku: env.M365_PROV_CLOUDPC_SKU ?? '',
    usageLocation: (env.M365_PROV_USAGE_LOCATION ?? 'US').trim().toUpperCase(),
    cloudPcApiVersion,
    offboardingEnabled,
  };
}

export interface EntraSyncConfig {
  /** True only when the flag is set AND an encryption key exists — see parseEntraSyncConfig. */
  enabled: boolean;
  intervalMs: number;
  /** AES-256-GCM key for the per-customer client secrets in org_integrations. */
  encryptionKey: string;
}

/** Six hours. Device inventory does not change fast enough to warrant more, and each tick is a
 *  full enumeration per configured customer. */
const ENTRA_SYNC_DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Entra/Intune device sync.
 *
 * Opting in is necessary but NOT sufficient, the same shape as the provisioning gate: without
 * INTEGRATION_ENC_KEY the stored per-customer secrets cannot be decrypted, so an "enabled" sync
 * would fail on every customer with an error that looks like a bad credential rather than a
 * missing key. Staying off is the honest state.
 */
export function parseEntraSyncConfig(env: NodeJS.ProcessEnv): EntraSyncConfig {
  const encryptionKey = env.INTEGRATION_ENC_KEY ?? '';
  const raw = Number(env.ENTRA_SYNC_INTERVAL_MS);
  // A garbage or negative value must not reach setInterval: setInterval(fn, NaN) fires
  // continuously, which would hammer Graph on a config typo.
  const intervalMs = Number.isFinite(raw) && raw > 0 ? raw : ENTRA_SYNC_DEFAULT_INTERVAL_MS;
  return {
    enabled: bool(env.ENTRA_SYNC_ENABLED) && Boolean(encryptionKey),
    intervalMs,
    encryptionKey,
  };
}

export function parseOidcConfig(env: NodeJS.ProcessEnv): OidcConfig {
  const enabled = bool(env.OIDC_ENABLED);
  const tenantId = env.OIDC_TENANT_ID ?? env.M365_TENANT_ID ?? '';
  // Azure Government authority (login.microsoftonline.us). Override for other clouds.
  const authority =
    env.OIDC_AUTHORITY ?? (tenantId ? `https://login.microsoftonline.us/${tenantId}/v2.0` : '');
  const clientId = env.OIDC_CLIENT_ID ?? '';
  const clientSecret = env.OIDC_CLIENT_SECRET ?? '';
  const redirectUri = env.OIDC_REDIRECT_URI ?? '';
  const webOrigin = (env.WEB_ORIGIN ?? 'http://localhost:3000').split(',')[0];
  const postLoginRedirect = env.OIDC_POST_LOGIN_REDIRECT ?? `${webOrigin}/auth/callback`;
  const allowedAppRoles = (env.OIDC_ALLOWED_APP_ROLES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const configured = enabled && !!authority && !!clientId && !!redirectUri;
  return {
    enabled,
    configured,
    authority,
    tenantId,
    clientId,
    clientSecret,
    redirectUri,
    postLoginRedirect,
    allowedAppRoles,
  };
}

export function parseOidcCustomerConfig(env: NodeJS.ProcessEnv): OidcCustomerConfig {
  const enabled = bool(env.OIDC_CUSTOMER_ENABLED);
  // Multitenant gov authority — accepts any onboarded customer tenant.
  const authority = env.OIDC_CUSTOMER_AUTHORITY ?? 'https://login.microsoftonline.us/organizations/v2.0';
  const clientId = env.OIDC_CUSTOMER_CLIENT_ID ?? '';
  const clientSecret = env.OIDC_CUSTOMER_CLIENT_SECRET ?? '';
  // Reuse the same callback + post-login redirect as the agent flow (the callback
  // branches on a signed mode flag in the tx cookie).
  const redirectUri = env.OIDC_REDIRECT_URI ?? '';
  const webOrigin = (env.WEB_ORIGIN ?? 'http://localhost:3000').split(',')[0];
  const postLoginRedirect = env.OIDC_POST_LOGIN_REDIRECT ?? `${webOrigin}/auth/callback`;
  const defaultRoleKey = env.OIDC_CUSTOMER_DEFAULT_ROLE ?? 'EndUser';
  const configured = enabled && !!authority && !!clientId && !!redirectUri;
  return { enabled, configured, authority, clientId, clientSecret, redirectUri, postLoginRedirect, defaultRoleKey };
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const adminDatabaseUrl = required('DATABASE_URL', 'postgres://nexus:nexus@localhost:5432/nexus');

export const config: Config = {
  // Azure App Service (Code/Linux) injects PORT and routes to it; honor it first,
  // then API_PORT, then the local default.
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 4000),
  adminDatabaseUrl,
  appDatabaseUrl:
    process.env.APP_DATABASE_URL ?? 'postgres://nexus_app:nexus_app@localhost:5432/nexus',
  sessionSigningKey: required('SESSION_SIGNING_KEY', 'dev-only-insecure-change-me'),
  webOrigin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','),
  enclave: (process.env.ENCLAVE as Enclave) ?? 'commercial',
  isProduction: process.env.NODE_ENV === 'production',
  m365: parseM365Config(process.env),
  oidc: parseOidcConfig(process.env),
  oidcCustomer: parseOidcCustomerConfig(process.env),
  notifications: {
    serviceDeskEmail:
      process.env.SERVICE_DESK_EMAIL ??
      (process.env.NODE_ENV === 'production' ? undefined : 'service-desk@nexus.example.com'),
  },
  retention: {
    // Default ON: resolved incidents/problems/changes are purged after `days`.
    enabled: process.env.RETENTION_PURGE_ENABLED ? bool(process.env.RETENTION_PURGE_ENABLED) : true,
    days: Number(process.env.RETENTION_DAYS ?? 30),
  },
  provisioning: parseProvisioningConfig(process.env),
  entraSync: parseEntraSyncConfig(process.env),
};
