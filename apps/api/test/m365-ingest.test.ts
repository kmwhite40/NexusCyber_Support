import { describe, it, expect, vi } from 'vitest';
import { fetchNewMessages, ingestMessage } from '../src/integrations/m365/ingest.js';

function makeSql(handlers: Record<string, any>) {
  const calls: any[] = [];
  const query = vi.fn(async (text: string, params?: any[]) => {
    calls.push({ text, params });
    for (const key of Object.keys(handlers)) {
      if (text.includes(key)) return handlers[key];
    }
    return { rows: [] };
  });
  return { sql: { query } as any, calls };
}

const msg = {
  id: 'm1',
  internetMessageId: '<abc@x>',
  fromAddress: 'sender@acme.gov',
  subject: 'Help please',
  bodyPreview: 'My laptop is broken',
};

describe('ingest', () => {
  it('creates a ticket when the sender domain maps to an org', async () => {
    const { sql, calls } = makeSql({
      'FROM integration_state': { rows: [] }, // not seen before
      'FROM organization_domains': { rows: [{ organization_id: 'org-acme' }] },
      'SELECT COALESCE(MAX': { rows: [{ n: 5 }] },
      'left(upper(name)': { rows: [{ p: 'ACME' }] },
      'INSERT INTO tickets': { rows: [{ id: 't-new' }] },
    });
    const out = await ingestMessage(sql, msg);
    expect(out.created).toBe(true);
    expect(calls.some((c) => c.text.includes('INSERT INTO tickets'))).toBe(true);
  });

  it('skips and reports when the domain is unmatched', async () => {
    const { sql } = makeSql({
      'FROM integration_state': { rows: [] },
      'FROM organization_domains': { rows: [] },
    });
    const out = await ingestMessage(sql, msg);
    expect(out.created).toBe(false);
    expect(out.reason).toBe('unmatched-domain');
  });

  it('skips a message already processed (dedupe)', async () => {
    const { sql, calls } = makeSql({
      'FROM integration_state': { rows: [{ value: true }] }, // seen
    });
    const out = await ingestMessage(sql, msg);
    expect(out.created).toBe(false);
    expect(out.reason).toBe('duplicate');
    expect(calls.some((c) => c.text.includes('INSERT INTO tickets'))).toBe(false);
  });

  it('fetchNewMessages reads the delta page and stores the deltaLink', async () => {
    const graphClient = {
      get: vi.fn(async () => ({
        value: [
          { id: 'm1', internetMessageId: '<a@x>', subject: 'S', bodyPreview: 'b',
            from: { emailAddress: { address: 'p@acme.gov' } } },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=NEXT',
      })),
      post: vi.fn(),
    } as any;
    const { sql } = makeSql({ 'FROM integration_state': { rows: [] } });
    const out = await fetchNewMessages(sql, graphClient, 'svc@agency.gov');
    expect(out).toHaveLength(1);
    expect(out[0].fromAddress).toBe('p@acme.gov');
  });
});
