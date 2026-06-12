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
};
