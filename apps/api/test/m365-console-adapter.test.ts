import { describe, it, expect } from 'vitest';
import { createConsoleAdapter } from '../src/integrations/m365/console-adapter.js';

describe('console adapter', () => {
  it('reports email capability and returns sent', async () => {
    const a = createConsoleAdapter();
    expect(a.name).toBe('console');
    expect(a.capabilities().email).toBe(true);
    const r = await a.sendEmail({ to: 'x@y.gov', subject: 'hi', html: '<p>h</p>', text: 'h' });
    expect(r.status).toBe('sent');
    expect(r.providerMessageId).toMatch(/^console:/);
  });

  it('reports teams capability and returns sent', async () => {
    const a = createConsoleAdapter();
    expect(a.capabilities().teams).toBe(true);
    const r = await a.sendTeams({ summary: 'sla breached', text: 'details' });
    expect(r.status).toBe('sent');
  });
});
