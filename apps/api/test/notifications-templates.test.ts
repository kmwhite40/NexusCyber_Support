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

  describe('CAB voting lifecycle', () => {
    it('cab_requested asks the board member to vote, with the deadline, and no sensitive detail', () => {
      const out = renderTemplate('change.cab_requested', {
        orgName: 'Acme',
        changeTitle: 'Upgrade firewall firmware',
        changeId: 'chg-1',
        voteDeadline: '2026-06-16T14:30:00.000Z',
      });
      expect(out.subject.toLowerCase()).toContain('vote requested');
      expect(out.text).toContain('Upgrade firewall firmware');
      expect(out.text).toContain('Vote deadline: 2026-06-16 14:30 UTC');
      expect(out.text.toLowerCase()).toContain('approve, reject, or abstain');
      // no risk/impact/plan narrative leaks into the notification
      expect(out.text.toLowerCase()).not.toContain('risk');
      expect(out.text.toLowerCase()).not.toContain('backout');
    });

    it('vote_cast tells the chair a vote landed, without saying which way', () => {
      const out = renderTemplate('change.vote_cast', { changeTitle: 'Upgrade firewall firmware' });
      expect(out.subject.toLowerCase()).toContain('vote cast');
      expect(out.text).toContain('Upgrade firewall firmware');
      expect(out.text.toLowerCase()).not.toMatch(/approve|reject|abstain/);
    });

    it('approved and rejected render creator-facing outcomes', () => {
      const approved = renderTemplate('change.approved', { changeTitle: 'Upgrade firewall firmware' });
      expect(approved.subject.toLowerCase()).toContain('approved');
      const rejected = renderTemplate('change.rejected', { changeTitle: 'Upgrade firewall firmware' });
      expect(rejected.subject.toLowerCase()).toContain('not approved');
    });

    it('scheduled includes the implementation window', () => {
      const out = renderTemplate('change.scheduled', {
        changeTitle: 'Upgrade firewall firmware',
        windowStart: '2026-06-20T02:00:00.000Z',
      });
      expect(out.subject.toLowerCase()).toContain('scheduled');
      expect(out.text).toContain('Window start: 2026-06-20 02:00 UTC');
    });

    it('vote_overdue tells the chair to follow up and explicitly makes no decision', () => {
      const out = renderTemplate('change.vote_overdue', {
        changeTitle: 'Upgrade firewall firmware',
        voteDeadline: '2026-06-16T14:30:00.000Z',
      });
      expect(out.subject.toLowerCase()).toContain('overdue');
      expect(out.text.toLowerCase()).toContain('quorum has not been reached');
      expect(out.text.toLowerCase()).toContain('no automatic action has been taken');
    });
  });
});

describe('ticket.created (service-desk alert)', () => {
  const full = {
    orgName: 'Acme',
    ticketId: 't-1',
    ticketNumber: 'ACME-000042',
    subject: 'VPN disconnects every few minutes',
    customerName: 'Jane Doe',
    requesterEmail: 'jane@acme.com',
    priority: 'P2',
    ticketType: 'incident',
    status: 'new',
    sourceChannel: 'email',
    submittedAt: '2026-06-13T14:30:00.000Z',
    responseDueAt: '2026-06-13T18:30:00.000Z',
    description: 'The tunnel drops roughly every ten minutes on the Boston office link.',
    webOrigin: 'https://anchor.azurewebsites.us',
  };

  it('puts the number, type, priority and subject in the subject line', () => {
    const out = renderTemplate('ticket.created', full);
    expect(out.subject).toBe('[ACME-000042] New incident (P2): VPN disconnects every few minutes');
  });

  it('carries the real ticket record in the body', () => {
    const out = renderTemplate('ticket.created', full);
    expect(out.text).toContain('Ticket ID: ACME-000042');
    expect(out.text).toContain('Organization: Acme');
    expect(out.text).toContain('Requester: Jane Doe <jane@acme.com>');
    expect(out.text).toContain('Priority: P2');
    expect(out.text).toContain('Type: Incident');
    expect(out.text).toContain('Status: New');
    expect(out.text).toContain('Received Via: Email');
    expect(out.text).toContain('Submitted Date/Time: 2026-06-13 14:30 UTC');
    expect(out.text).toContain('Response Due: 2026-06-13 18:30 UTC');
    expect(out.text).toContain('Subject: VPN disconnects every few minutes');
    expect(out.text).toContain('The tunnel drops roughly every ten minutes');
    expect(out.text).toContain('https://anchor.azurewebsites.us/tickets/t-1');
    expect(out.text).toContain('Automated Notification');
    expect(out.html).toContain('<li><strong>Ticket ID:</strong> ACME-000042</li>');
    expect(out.html).toContain('href="https://anchor.azurewebsites.us/tickets/t-1"');
  });

  it('omits rows it has no data for instead of printing blanks', () => {
    const out = renderTemplate('ticket.created', { orgName: 'Acme', ticketNumber: 'ACME-1', subject: 'help' });
    expect(out.subject).toBe('[ACME-1] New ticket: help');
    expect(out.text).not.toMatch(/Requester:\s*$/m);
    expect(out.text).not.toContain('Response Due:');
    expect(out.text).not.toContain('undefined');
    expect(out.text).toContain('Sign in to the support portal');
  });

  it('truncates a long description rather than mailing the whole thread', () => {
    const out = renderTemplate('ticket.created', { ...full, description: 'x'.repeat(2000) });
    expect(out.text).toContain('…');
    expect(out.text.length).toBeLessThan(1500);
  });

  it('escapes user-controlled description and requester fields in the html body', () => {
    const out = renderTemplate('ticket.created', {
      ...full,
      customerName: '<script>alert(1)</script>',
      description: '<img src=x onerror=alert(1)>',
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('<img src=x');
  });
});
