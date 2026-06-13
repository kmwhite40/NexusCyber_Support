// Per-event notification templates (docs/nexus/06 §K.3 template engine).
// A small TS map keeps us dependency-free; tenant branding (org name / from-name)
// is threaded through the context. i18n keys are future work.

export interface TemplateContext {
  orgName?: string;
  ticketNumber?: string;
  subject?: string;
  metric?: string;
  severity?: string;
  customerName?: string;
  submittedAt?: string;
  priority?: string;
  status?: string;
  visibility?: string;
  commentExcerpt?: string;
  resolutionCode?: string;
  ticketId?: string;
  webOrigin?: string;
  [k: string]: unknown;
}

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

// Escape user-controlled values before interpolating into HTML email bodies.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render an ISO timestamp as an unambiguous UTC string (gov-friendly), e.g.
// "2026-06-13 14:30 UTC". Falls back to the raw value if unparseable.
function fmtWhen(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function wrap(title: string, lines: string[]): RenderedTemplate {
  const text = [title, '', ...lines].join('\n');
  const html =
    `<h2>${escapeHtml(title)}</h2>` + lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('');
  return { subject: title, html, text };
}

type Renderer = (c: TemplateContext) => RenderedTemplate;

const TEMPLATES: Record<string, Renderer> = {
  'ticket.created': (c) =>
    wrap(`[${c.ticketNumber}] New ticket: ${c.subject ?? ''}`, [
      `A new ticket was created for ${c.orgName ?? 'your organization'}.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
  'ticket.acknowledged': (c) => {
    const brand = 'Anchor Support';
    const name = (c.customerName ?? '').trim() || 'there';
    const summary = c.subject || '(no summary provided)';
    const when = fmtWhen(c.submittedAt);
    const priority = c.priority || 'To be assigned';
    const text = [
      `Hello ${name},`,
      '',
      `Thank you for contacting ${brand}.`,
      '',
      'We have received your support request and created a ticket for our team to review. A support specialist will evaluate the issue and follow up with next steps as soon as possible.',
      '',
      'Ticket Details:',
      `Ticket ID: ${c.ticketNumber ?? ''}`,
      `Issue Summary: ${summary}`,
      `Submitted Date/Time: ${when}`,
      `Priority: ${priority}`,
      '',
      'Please keep this ticket number for reference in any future communication about this request.',
      '',
      'Thank you,',
      brand,
      'Automated Notification',
    ].join('\n');
    const html =
      `<p>Hello ${escapeHtml(name)},</p>` +
      `<p>Thank you for contacting ${brand}.</p>` +
      `<p>We have received your support request and created a ticket for our team to review. A support specialist will evaluate the issue and follow up with next steps as soon as possible.</p>` +
      `<p><strong>Ticket Details:</strong></p>` +
      `<ul>` +
      `<li><strong>Ticket ID:</strong> ${escapeHtml(c.ticketNumber ?? '')}</li>` +
      `<li><strong>Issue Summary:</strong> ${escapeHtml(summary)}</li>` +
      `<li><strong>Submitted Date/Time:</strong> ${escapeHtml(when)}</li>` +
      `<li><strong>Priority:</strong> ${escapeHtml(priority)}</li>` +
      `</ul>` +
      `<p>Please keep this ticket number for reference in any future communication about this request.</p>` +
      `<p>Thank you,<br/>${brand}<br/><em>Automated Notification</em></p>`;
    return { subject: `[${c.ticketNumber ?? 'Ticket'}] We received your support request`, html, text };
  },
  'ticket.commented': (c) => {
    const brand = 'Anchor Support';
    const excerpt = (c.commentExcerpt ?? '').trim();
    // Internal notes go to agents; public replies go to the requester (+ assignee).
    if (c.visibility === 'internal') {
      return wrap(`[${c.ticketNumber}] Internal note added`, [
        `An internal note was added to ticket ${c.ticketNumber}.`,
        excerpt ? `Note: ${excerpt}` : '',
        `Subject: ${c.subject ?? ''}`,
      ].filter(Boolean));
    }
    const text = [
      `Hello,`,
      '',
      `${brand} has responded to your support request (ticket ${c.ticketNumber}).`,
      '',
      excerpt ? `Message from our team:` : `Please sign in to view the latest update.`,
      ...(excerpt ? [excerpt] : []),
      '',
      `Subject: ${c.subject ?? ''}`,
      '',
      `You can reply to this email or sign in to the support portal to continue the conversation. Please keep ticket ${c.ticketNumber} in the subject for reference.`,
      '',
      'Thank you,',
      brand,
      'Automated Notification',
    ].join('\n');
    const html =
      `<p>Hello,</p>` +
      `<p>${brand} has responded to your support request (ticket <strong>${escapeHtml(c.ticketNumber ?? '')}</strong>).</p>` +
      (excerpt
        ? `<p><strong>Message from our team:</strong></p><blockquote>${escapeHtml(excerpt)}</blockquote>`
        : `<p>Please sign in to the support portal to view the latest update.</p>`) +
      `<p><strong>Subject:</strong> ${escapeHtml(c.subject ?? '')}</p>` +
      `<p>You can reply to this email or sign in to continue the conversation. Please keep ticket ${escapeHtml(c.ticketNumber ?? '')} referenced.</p>` +
      `<p>Thank you,<br/>${brand}<br/><em>Automated Notification</em></p>`;
    return { subject: `[${c.ticketNumber}] New reply from ${brand}`, html, text };
  },
  'ticket.resolved': (c) => {
    const brand = 'Anchor Support';
    const text = [
      `Hello,`,
      '',
      `Good news — your support request has been resolved.`,
      '',
      'Ticket Details:',
      `Ticket ID: ${c.ticketNumber ?? ''}`,
      `Issue Summary: ${c.subject ?? ''}`,
      c.resolutionCode ? `Resolution: ${c.resolutionCode}` : '',
      '',
      `If your issue is fully addressed, no action is needed. If you still need help, reply to this email (keep ticket ${c.ticketNumber} in the subject) or sign in to the portal to reopen the request.`,
      '',
      'Thank you for letting us help,',
      brand,
      'Automated Notification',
    ].filter((l) => l !== '').join('\n');
    const html =
      `<p>Hello,</p>` +
      `<p>Good news — your support request has been <strong>resolved</strong>.</p>` +
      `<p><strong>Ticket Details:</strong></p>` +
      `<ul>` +
      `<li><strong>Ticket ID:</strong> ${escapeHtml(c.ticketNumber ?? '')}</li>` +
      `<li><strong>Issue Summary:</strong> ${escapeHtml(c.subject ?? '')}</li>` +
      (c.resolutionCode ? `<li><strong>Resolution:</strong> ${escapeHtml(c.resolutionCode)}</li>` : '') +
      `</ul>` +
      `<p>If your issue is fully addressed, no action is needed. If you still need help, reply to this email (keep ticket ${escapeHtml(c.ticketNumber ?? '')} in the subject) or sign in to the portal to reopen the request.</p>` +
      `<p>Thank you for letting us help,<br/>${brand}<br/><em>Automated Notification</em></p>`;
    return { subject: `[${c.ticketNumber}] Your request has been resolved`, html, text };
  },
  'csat.survey_created': (c) => {
    const brand = 'Anchor Support';
    const link = c.webOrigin && c.ticketId ? `${c.webOrigin}/tickets/${c.ticketId}` : '';
    const text = [
      `Hello,`,
      '',
      `Your recent support request (ticket ${c.ticketNumber}) has been resolved, and we'd love your feedback.`,
      '',
      `How would you rate your experience? It takes just a moment:`,
      link ? link : `Sign in to the support portal and open ticket ${c.ticketNumber} to rate it.`,
      '',
      `Subject: ${c.subject ?? ''}`,
      '',
      'Thank you,',
      brand,
      'Automated Notification',
    ].join('\n');
    const html =
      `<p>Hello,</p>` +
      `<p>Your recent support request (ticket <strong>${escapeHtml(c.ticketNumber ?? '')}</strong>) has been resolved, and we'd love your feedback.</p>` +
      `<p><strong>How would you rate your experience?</strong> It takes just a moment.</p>` +
      (link
        ? `<p><a href="${escapeHtml(link)}">Rate your experience &rarr;</a></p>`
        : `<p>Sign in to the support portal and open ticket ${escapeHtml(c.ticketNumber ?? '')} to rate it.</p>`) +
      `<p><strong>Subject:</strong> ${escapeHtml(c.subject ?? '')}</p>` +
      `<p>Thank you,<br/>${brand}<br/><em>Automated Notification</em></p>`;
    return { subject: `[${c.ticketNumber}] How did we do?`, html, text };
  },
  'ticket.assigned': (c) =>
    wrap(`[${c.ticketNumber}] Your ticket is now in progress`, [
      `Ticket ${c.ticketNumber} has been assigned to a support specialist and is now being worked on.`,
      `Subject: ${c.subject ?? ''}`,
      `We'll follow up here with any updates. — Anchor Support`,
    ]),
  'ticket.closed': (c) =>
    wrap(`[${c.ticketNumber}] Your ticket has been closed`, [
      `Ticket ${c.ticketNumber} has been closed.`,
      `Subject: ${c.subject ?? ''}`,
      `If you still need help, reply to this email (keep ${c.ticketNumber} in the subject) or open a new request and we'll be glad to assist.`,
      `Thank you, — Anchor Support`,
    ]),
  'ticket.reopened': (c) =>
    wrap(`[${c.ticketNumber}] Your ticket has been reopened`, [
      `Ticket ${c.ticketNumber} has been reopened and our team will continue working on it.`,
      `Subject: ${c.subject ?? ''}`,
      `No action is needed from you right now — we'll follow up with next steps. — Anchor Support`,
    ]),
  'approval.requested': (c) =>
    wrap(`[${c.ticketNumber}] Your request is pending approval`, [
      `Thank you — your request (${c.ticketNumber}) has been submitted and is awaiting approval.`,
      `Item: ${c.subject ?? ''}`,
      `We'll email you as soon as it's approved, or if more information is needed. — Anchor Support`,
    ]),
  'approval.approved': (c) =>
    wrap(`[${c.ticketNumber}] Your request has been approved`, [
      `Good news — your request (${c.ticketNumber}) has been approved and is now being fulfilled.`,
      `Item: ${c.subject ?? ''}`,
      `We'll follow up with next steps. — Anchor Support`,
    ]),
  'approval.rejected': (c) =>
    wrap(`[${c.ticketNumber}] Update on your request`, [
      `Your request (${c.ticketNumber}) was not approved at this time.`,
      `Item: ${c.subject ?? ''}`,
      `If you have questions or believe this was in error, reply to this email and our team will follow up. — Anchor Support`,
    ]),
  'ticket.status_changed': (c) =>
    wrap(`[${c.ticketNumber}] Status changed`, [
      `Ticket ${c.ticketNumber} changed status.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
  'sla.warning': (c) =>
    wrap(`[${c.ticketNumber}] SLA warning (${c.metric ?? 'sla'})`, [
      `The ${c.metric ?? 'SLA'} target for ticket ${c.ticketNumber} is at risk.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
  'sla.breached': (c) =>
    wrap(`[${c.ticketNumber}] SLA breached (${c.metric ?? 'sla'})`, [
      `The ${c.metric ?? 'SLA'} target for ticket ${c.ticketNumber} has been breached.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
  'posture.finding_created': (c) =>
    wrap(`New posture finding (${c.severity ?? 'finding'})`, [
      `A new ${c.severity ?? ''} posture finding was created for ${c.orgName ?? 'your organization'}.`,
    ]),
};

export function renderTemplate(eventType: string, ctx: TemplateContext): RenderedTemplate {
  const renderer = TEMPLATES[eventType];
  if (renderer) return renderer(ctx);
  return wrap(`Notification for ${ctx.orgName ?? 'your organization'}`, [
    `Event: ${eventType}`,
  ]);
}
