import { describe, it, expect } from 'vitest';
import { parseProvisioningConfig } from '../src/config.js';

describe('parseProvisioningConfig', () => {
  it('is disabled without explicit opt-in', () => {
    expect(parseProvisioningConfig({}).enabled).toBe(false);
  });

  it('splits the baseline SKU list and trims blanks', () => {
    const c = parseProvisioningConfig({ M365_PROV_BASELINE_SKUS: 'SPE_E3_USGOV_GCCHIGH, MDATP_XPLAT ,' });
    expect(c.baselineSkus).toEqual(['SPE_E3_USGOV_GCCHIGH', 'MDATP_XPLAT']);
  });

  it('refuses to report enabled when required settings are missing', () => {
    expect(parseProvisioningConfig({ M365_PROV_ENABLED: 'true' }).enabled).toBe(false);
  });

  // CRITICAL 2. An empty baseline is the one omission that failed OPEN: the planner's licence
  // loop had nothing to iterate, so it produced no blocker and no sku ids, `assign_licenses`
  // no-opped, and `assign_cloudpc` still added the account to the Cloud PC policy group — a
  // live, unlicensed federal identity whose Cloud PC silently never builds.
  it('stays dark with a fully configured app but an EMPTY licence baseline', () => {
    const env = {
      M365_PROV_ENABLED: 'true',
      M365_PROV_TENANT_ID: 't', M365_PROV_CLIENT_ID: 'c', M365_PROV_CLIENT_SECRET: 's',
      M365_PROV_UPN_DOMAIN: 'sbsfederal.com',
    };
    expect(parseProvisioningConfig(env).enabled).toBe(false);
    expect(parseProvisioningConfig({ ...env, M365_PROV_BASELINE_SKUS: '' }).enabled).toBe(false);
    // A list of nothing but separators and blanks is still empty.
    expect(parseProvisioningConfig({ ...env, M365_PROV_BASELINE_SKUS: ' , , ' }).enabled).toBe(false);
    // ...and the same config with one real SKU is the enabled case, so the assertions above
    // are about the baseline and not about some other missing setting.
    expect(parseProvisioningConfig({ ...env, M365_PROV_BASELINE_SKUS: 'SPE_E3_USGOV_GCCHIGH' }).enabled).toBe(true);
  });

  it('defaults cloudPcApiVersion to beta when the env var is unset', () => {
    expect(parseProvisioningConfig({}).cloudPcApiVersion).toBe('beta');
  });

  it('honours cloudPcApiVersion when explicitly set to v1.0', () => {
    expect(parseProvisioningConfig({ M365_PROV_CLOUDPC_API_VERSION: 'v1.0' }).cloudPcApiVersion).toBe('v1.0');
  });

  it('falls back to the default cloudPcApiVersion on a garbage value', () => {
    expect(parseProvisioningConfig({ M365_PROV_CLOUDPC_API_VERSION: 'v2.0-nonsense' }).cloudPcApiVersion).toBe('beta');
  });
});
