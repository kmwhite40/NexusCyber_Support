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
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const adminDatabaseUrl = required('DATABASE_URL', 'postgres://nexus:nexus@localhost:5432/nexus');

export const config: Config = {
  port: Number(process.env.API_PORT ?? 4000),
  adminDatabaseUrl,
  appDatabaseUrl:
    process.env.APP_DATABASE_URL ?? 'postgres://nexus_app:nexus_app@localhost:5432/nexus',
  sessionSigningKey: required('SESSION_SIGNING_KEY', 'dev-only-insecure-change-me'),
  webOrigin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','),
  enclave: (process.env.ENCLAVE as Enclave) ?? 'commercial',
  isProduction: process.env.NODE_ENV === 'production',
};
