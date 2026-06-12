import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../src/modules/notifications-templates.js';

describe('renderTemplate', () => {
  it('renders an sla.breached email with ticket context', () => {
    const out = renderTemplate('sla.breached', {
      orgName: 'Acme',
      ticketNumber: 'ACME-000123',
      subject: 'Server down',
      metric: 'resolution',
    });
    expect(out.subject).toContain('ACME-000123');
    expect(out.subject.toLowerCase()).toContain('sla');
    expect(out.html).toContain('Server down');
    expect(out.text).toContain('ACME-000123');
  });

  it('falls back to a generic template for unknown events', () => {
    const out = renderTemplate('something.unmapped', { orgName: 'Acme' });
    expect(out.subject).toContain('Acme');
    expect(out.text.length).toBeGreaterThan(0);
  });
});
