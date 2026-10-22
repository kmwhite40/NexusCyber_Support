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

  // The link moved from the portal deep link to the PUBLIC survey, because the deep link sat
  // behind the login wall and a survey you must authenticate to answer is one most people never
  // answer. Covered in full in csat-invite-template.test.ts; this keeps the subject pinned here
  // alongside its siblings.
  it('csat survey renders a rating link to the public survey', () => {
    const out = renderTemplate('csat.survey_created', {
      ticketNumber: 'ACME-9', subject: 'Laptop', ticketId: 't-123',
      webOrigin: 'https://anchor.azurewebsites.us', surveyToken: 'TOKEN1234567890123456789',
    });
    expect(out.subject.toLowerCase()).toContain('how did we do');
    expect(out.html).toContain('https://anchor.azurewebsites.us/survey/TOKEN1234567890123456789');
    expect(out.html).not.toContain('/tickets/t-123');
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
    // Board members asked to vote from the email itself: it carries the change record and a
    // link straight to it, not just a title and "go find it in the portal".
    it('cab_requested carries the change details and a direct link to the change', () => {
      const out = renderTemplate('change.cab_requested', {
        orgName: 'Acme',
        webOrigin: 'https://anchor.example',
        changeTitle: 'Upgrade firewall firmware',
        changeId: 'chg-1',
        voteDeadline: '2026-06-16T14:30:00.000Z',
        changeType: 'normal',
        changeRisk: 'high',
        changeImpact: 'medium',
        changeLikelihood: 'low',
        changeRaisedBy: 'Dana Raiser',
        changeWindowStart: '2026-06-20T02:00:00.000Z',
        changeWindowEnd: '2026-06-20T04:00:00.000Z',
        changeDescription: 'Move the edge firewalls to 7.4.3.',
        changeImplementationPlan: 'Fail over, upgrade standby, fail back.',
        changeTestPlan: 'VPN and web reachability checks.',
        changeBackoutPlan: 'Reinstall 7.2.8 from the saved image.',
      });
      expect(out.subject).toBe('CAB vote requested: Upgrade firewall firmware');
      for (const want of [
        'Upgrade firewall firmware', 'Organization: Acme', 'Type: Normal', 'Risk: High', 'Impact: Medium',
        'Likelihood: Low', 'Requested By: Dana Raiser', 'Planned Window: 2026-06-20 02:00 UTC – 2026-06-20 04:00 UTC',
        'Vote Deadline: 2026-06-16 14:30 UTC', 'Move the edge firewalls to 7.4.3.', 'Fail over, upgrade standby, fail back.',
        'VPN and web reachability checks.', 'Reinstall 7.2.8 from the saved image.',
        'https://anchor.example/changes?change=chg-1',
      ]) expect(out.text).toContain(want);
      expect(out.html).toContain('<a href="https://anchor.example/changes?change=chg-1">');
      expect(out.text.toLowerCase()).toContain('approve, reject, or abstain');
    });

    it('cab_requested escapes change text in the HTML body and drops empty fields', () => {
      const out = renderTemplate('change.cab_requested', {
        changeTitle: '<b>x</b>', changeId: 'chg-1', changeDescription: '<script>alert(1)</script>',
      });
      expect(out.html).not.toContain('<script>');
      expect(out.html).toContain('&lt;script&gt;');
      expect(out.text).not.toContain('Impact:');
      expect(out.text).not.toContain('Backout plan');
      // No web origin configured: no broken link, just the portal instruction.
      expect(out.text).not.toContain('/changes?change=');
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

  // Every automatic email links to the thing it is about, so the reader is one click from it.
  describe('resource links', () => {
    const W = 'https://anchor.example';
    it.each([
      'ticket.acknowledged', 'ticket.commented', 'ticket.resolved', 'ticket.assigned', 'ticket.closed',
      'ticket.reopened', 'ticket.status_changed', 'approval.requested', 'approval.approved', 'approval.rejected',
      'sla.warning', 'sla.breached', 'ticket.created',
    ])('%s links to the ticket', (type) => {
      const out = renderTemplate(type, { webOrigin: W, ticketId: 't-1', ticketNumber: 'ACME-1', subject: 'VPN' });
      expect(out.text).toContain(`${W}/tickets/t-1`);
      expect(out.html).toContain(`href="${W}/tickets/t-1"`);
    });

    it('links an internal note to the ticket too', () => {
      const out = renderTemplate('ticket.commented', { webOrigin: W, ticketId: 't-1', ticketNumber: 'ACME-1', visibility: 'internal' });
      expect(out.html).toContain(`href="${W}/tickets/t-1"`);
    });

    it.each(['change.cab_requested', 'change.vote_cast', 'change.approved', 'change.rejected', 'change.scheduled', 'change.vote_overdue'])(
      '%s links to the change',
      (type) => {
        const out = renderTemplate(type, { webOrigin: W, changeId: 'chg-1', changeTitle: 'Firewall' });
        expect(out.html).toContain(`href="${W}/changes?change=chg-1"`);
        expect(out.text.match(/\/changes\?change=chg-1/g)).toHaveLength(1); // not twice
      },
    );

    it('links posture and on-call notices to their pages', () => {
      expect(renderTemplate('posture.finding_created', { webOrigin: W }).html).toContain(`href="${W}/posture"`);
      expect(renderTemplate('oncall.acknowledgement_required', { webOrigin: W }).html).toContain(`href="${W}/oncall"`);
    });

    it('keeps the satisfaction survey on its public link, not a sign-in link', () => {
      const out = renderTemplate('csat.survey_created', { webOrigin: W, ticketId: 't-1', ticketNumber: 'ACME-1', surveyToken: 'tok' });
      expect(out.text).toContain(`${W}/survey/tok`);
      expect(out.text).not.toContain('/tickets/t-1');
    });

    it('adds no link without a web origin or a resource id', () => {
      expect(renderTemplate('ticket.closed', { ticketId: 't-1', ticketNumber: 'ACME-1' }).html).not.toContain('href=');
      expect(renderTemplate('ticket.closed', { webOrigin: W, ticketNumber: 'ACME-1' }).html).not.toContain('href=');
    });
  });
});

