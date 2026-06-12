import { describe, it, expect } from 'vitest';
import { parseM365Config } from '../src/config.js';

describe('parseM365Config', () => {
  it('is disabled with no env', () => {
    const c = parseM365Config({});
    expect(c.enabled).toBe(false);
    expect(c.cloud).toBe('gcc');
  });

  it('parses a full enabled config', () => {
    const c = parseM365Config({
      M365_ENABLED: 'true',
      M365_CLOUD: 'gcc',
      M365_TENANT_ID: 't-1',
      M365_CLIENT_ID: 'c-1',
      M365_CLIENT_SECRET: 's-1',
      M365_SERVICE_MAILBOX: 'svc@agency.gov',
      M365_INGEST_ENABLED: 'true',
      M365_TEAMS_ENABLED: 'false',
    });
    expect(c.enabled).toBe(true);
    expect(c.tenantId).toBe('t-1');
    expect(c.serviceMailbox).toBe('svc@agency.gov');
    expect(c.ingestEnabled).toBe(true);
    expect(c.teamsEnabled).toBe(false);
  });

  it('treats enabled=true but missing secret as not fully configured', () => {
    const c = parseM365Config({ M365_ENABLED: 'true', M365_TENANT_ID: 't' });
    expect(c.enabled).toBe(true);
    expect(c.configured).toBe(false);
  });
});
