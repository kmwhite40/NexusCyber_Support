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

  it('escapes HTML in user-controlled fields in the html body (injection guard)', () => {
    const out = renderTemplate('ticket.created', {
      orgName: 'Acme',
      ticketNumber: 'ACME-1',
      subject: '<img src=x onerror=alert(1)>',
    });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).toContain('&lt;img src=x');
    // the plaintext alternative keeps the raw value
    expect(out.text).toContain('<img src=x onerror=alert(1)>');
  });

  it('renders a customer acknowledgment with name, ticket id, summary, time, and priority', () => {
    const out = renderTemplate('ticket.acknowledged', {
      orgName: 'Acme',
      customerName: 'Jane Doe',
      ticketNumber: 'ACME-000005',
      subject: 'Laptop is broken',
      submittedAt: '2026-06-13T14:30:00.000Z',
      priority: 'P3',
    });
    expect(out.subject).toContain('ACME-000005');
    expect(out.text).toContain('Hello Jane Doe,');
    expect(out.text).toContain('Ticket ID: ACME-000005');
    expect(out.text).toContain('Issue Summary: Laptop is broken');
    expect(out.text).toContain('Submitted Date/Time: 2026-06-13 14:30 UTC');
    expect(out.text).toContain('Priority: P3');
    expect(out.text).toContain('Anchor Support');
    expect(out.text).toContain('Automated Notification');
    // HTML escapes the user-controlled name/summary
    expect(out.html).toContain('<li><strong>Ticket ID:</strong> ACME-000005</li>');
  });

  it('acknowledgment falls back gracefully when name/priority are missing', () => {
    const out = renderTemplate('ticket.acknowledged', { ticketNumber: 'X-1', subject: 'help' });
    expect(out.text).toContain('Hello there,');
    expect(out.text).toContain('Priority: To be assigned');
  });

  it('public comment renders a customer-facing "new reply" with the excerpt', () => {
    const out = renderTemplate('ticket.commented', {
      ticketNumber: 'ACME-1', subject: 'VPN', visibility: 'public', commentExcerpt: 'We pushed a fix, please retry.',
    });
    expect(out.subject).toContain('New reply');
    expect(out.text).toContain('has responded to your support request');
    expect(out.text).toContain('We pushed a fix, please retry.');
  });

  it('internal comment renders an agent-facing internal note (not customer wording)', () => {
    const out = renderTemplate('ticket.commented', {
      ticketNumber: 'ACME-1', subject: 'VPN', visibility: 'internal', commentExcerpt: 'check the firewall',
    });
    expect(out.subject).toContain('Internal note');
    expect(out.text).not.toContain('has responded to your support request');
  });

  it('resolved renders a resolution notice with reopen guidance', () => {
    const out = renderTemplate('ticket.resolved', { ticketNumber: 'ACME-9', subject: 'Laptop', resolutionCode: 'fixed' });
    expect(out.subject.toLowerCase()).toContain('resolved');
    expect(out.text).toContain('Ticket ID: ACME-9');
    expect(out.text.toLowerCase()).toContain('reopen');
  });

  it('csat survey renders a rating link to the ticket page', () => {
    const out = renderTemplate('csat.survey_created', {
      ticketNumber: 'ACME-9', subject: 'Laptop', ticketId: 't-123', webOrigin: 'https://anchor.azurewebsites.us',
    });
    expect(out.subject.toLowerCase()).toContain('how did we do');
    expect(out.html).toContain('https://anchor.azurewebsites.us/tickets/t-123');
  });

  it('assigned reads as "in progress" for the customer', () => {
    const out = renderTemplate('ticket.assigned', { ticketNumber: 'ACME-2', subject: 'VPN' });
    expect(out.subject.toLowerCase()).toContain('in progress');
    expect(out.text.toLowerCase()).toContain('being worked on');
  });

  it('closed and reopened render their respective notices', () => {
    const closed = renderTemplate('ticket.closed', { ticketNumber: 'ACME-3', subject: 'VPN' });
    expect(closed.subject.toLowerCase()).toContain('closed');
    const reopened = renderTemplate('ticket.reopened', { ticketNumber: 'ACME-3', subject: 'VPN' });
    expect(reopened.subject.toLowerCase()).toContain('reopened');
  });

  it('approval outcomes render requester-facing messages', () => {
    expect(renderTemplate('approval.requested', { ticketNumber: 'REQ-1', subject: 'New laptop' }).subject.toLowerCase()).toContain('pending approval');
    expect(renderTemplate('approval.approved', { ticketNumber: 'REQ-1', subject: 'New laptop' }).text.toLowerCase()).toContain('approved');
    expect(renderTemplate('approval.rejected', { ticketNumber: 'REQ-1', subject: 'New laptop' }).text.toLowerCase()).toContain('not approved');
  });
});
