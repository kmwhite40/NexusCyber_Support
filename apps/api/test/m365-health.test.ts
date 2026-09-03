import { describe, it, expect, vi } from 'vitest';
import { probe } from '../src/integrations/m365/health.js';

describe('m365 health probe', () => {
  it('reports skipped when no graph client (not configured)', async () => {
    const checks = await probe(null, 'svc@x.gov');
    expect(checks.every((c) => c.status === 'skipped')).toBe(true);
  });

  it('passes mailbox + token checks when graph read succeeds', async () => {
    const graphClient = { get: vi.fn(async () => ({ id: 'u1', mail: 'svc@x.gov' })), post: vi.fn() } as any;
    const checks = await probe(graphClient, 'svc@x.gov');
    const mailbox = checks.find((c) => c.check_name === 'mailbox');
    expect(mailbox?.status).toBe('pass');
  });

  it('fails mailbox check when graph read throws', async () => {
    const graphClient = { get: vi.fn(async () => { throw new Error('403'); }), post: vi.fn() } as any;
    const checks = await probe(graphClient, 'svc@x.gov');
    const mailbox = checks.find((c) => c.check_name === 'mailbox');
    expect(mailbox?.status).toBe('fail');
  });
});
