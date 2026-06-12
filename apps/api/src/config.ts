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
};
