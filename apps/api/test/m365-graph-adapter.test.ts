import { describe, it, expect, vi } from 'vitest';
import { createGraphAdapter } from '../src/integrations/m365/graph-adapter.js';

describe('graph adapter — email', () => {
  it('posts sendMail to the service mailbox and returns sent', async () => {
    const post = vi.fn(async () => null); // 202 -> null
    const graphClient = { get: vi.fn(), post } as any;
    const a = createGraphAdapter({ graphClient, serviceMailbox: 'svc@agency.gov', teamsEnabled: false });
    const r = await a.sendEmail({ to: 'u@x.gov', subject: 'S', html: '<p>h</p>', text: 'h' });
    expect(r.status).toBe('sent');
    expect(post.mock.calls[0][0]).toBe('/users/svc@agency.gov/sendMail');
    const body = post.mock.calls[0][1] as any;
    expect(body.message.toRecipients[0].emailAddress.address).toBe('u@x.gov');
    expect(body.message.subject).toBe('S');
  });

  it('returns failed when the graph call throws', async () => {
    const graphClient = { get: vi.fn(), post: vi.fn(async () => { throw new Error('boom'); }) } as any;
    const a = createGraphAdapter({ graphClient, serviceMailbox: 'svc@agency.gov', teamsEnabled: false });
    const r = await a.sendEmail({ to: 'u@x.gov', subject: 'S', html: 'h', text: 'h' });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('boom');
  });

  it('reports teams capability from the flag', () => {
    const graphClient = { get: vi.fn(), post: vi.fn() } as any;
    expect(createGraphAdapter({ graphClient, serviceMailbox: 'm', teamsEnabled: false }).capabilities().teams).toBe(false);
    expect(createGraphAdapter({ graphClient, serviceMailbox: 'm', teamsEnabled: true }).capabilities().teams).toBe(true);
  });
});
