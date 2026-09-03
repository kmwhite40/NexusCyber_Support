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
  requesterEmail?: string;
  submittedAt?: string;
  responseDueAt?: string;
  ticketType?: string;
  sourceChannel?: string;
  description?: string;
  priority?: string;
  status?: string;
  visibility?: string;
  commentExcerpt?: string;
  resolutionCode?: string;
  ticketId?: string;
  webOrigin?: string;
  changeId?: string;
  changeTitle?: string;
  voteDeadline?: string;
  windowStart?: string;
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

// 'service_request' -> 'Service Request'. Enum-ish DB values (type, status,
// source_channel) are snake_case; emails should read like English.
function titleize(s?: string): string {
  if (!s) return '';
  return s
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// Free-text the customer wrote. Desk alerts carry enough to triage from the
// inbox, not the whole mail thread (ingested email bodies can be huge).
const EXCERPT_MAX = 500;
function excerpt(s?: string): string {
  const t = (s ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  return t.length <= EXCERPT_MAX ? t : `${t.slice(0, EXCERPT_MAX).trimEnd()}…`;
}

// "Label: value" rows, dropping the ones we have no data for — a desk alert
// full of empty labels reads as a broken template.
function detailRows(rows: Array<[string, string | undefined]>): Array<[string, string]> {
  return rows.filter((r): r is [string, string] => Boolean(r[1] && r[1].trim()));
}

function wrap(title: string, lines: string[]): RenderedTemplate {
  const text = [title, '', ...lines].join('\n');
  const html =
    `<h2>${escapeHtml(title)}</h2>` + lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('');
  return { subject: title, html, text };
}

type Renderer = (c: TemplateContext) => RenderedTemplate;

const TEMPLATES: Record<string, Renderer> = {
  // Agent-facing: the service desk triages straight from this email, so it carries
  // the whole ticket record (requester, priority, SLA clock, description excerpt)
  // plus a deep link. Recipients are internal only (notifications-recipients.ts).
  'ticket.created': (c) => {
    const brand = 'Anchor Support';
    const number = c.ticketNumber ?? '';
    const subject = c.subject ?? '(no subject)';
    const kind = titleize(c.ticketType).toLowerCase() || 'ticket';
    const org = c.orgName ?? 'an unknown organization';
    const requester = c.customerName?.trim()
      ? c.requesterEmail
        ? `${c.customerName.trim()} <${c.requesterEmail}>`
        : c.customerName.trim()
      : c.requesterEmail;
    const body = excerpt(c.description);
    const link = c.webOrigin && c.ticketId ? `${c.webOrigin}/tickets/${c.ticketId}` : '';
    const rows = detailRows([
      ['Ticket ID', number],
      ['Organization', c.orgName],
      ['Requester', requester],
      ['Priority', c.priority],
      ['Type', titleize(c.ticketType)],
      ['Status', titleize(c.status)],
      ['Received Via', titleize(c.sourceChannel)],
      ['Submitted Date/Time', fmtWhen(c.submittedAt)],
      ['Response Due', fmtWhen(c.responseDueAt)],
      ['Subject', subject],
    ]);
    const headline = `A new ${kind} was submitted for ${org} and is awaiting triage.`;
    const text = [
      `New ${kind}${number ? ` ${number}` : ''}`,
      '',
      headline,
      '',
      'Ticket Details:',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      ...(body ? ['', 'Description:', body] : []),
      '',
      link ? `Open the ticket: ${link}` : `Sign in to the support portal to review and assign this ticket.`,
      '',
      brand,
      'Automated Notification',
    ].join('\n');
    const html =
      `<h2>New ${escapeHtml(kind)}${number ? ` ${escapeHtml(number)}` : ''}</h2>` +
      `<p>${escapeHtml(headline)}</p>` +
      `<p><strong>Ticket Details:</strong></p>` +
      `<ul>` +
      rows.map(([k, v]) => `<li><strong>${k}:</strong> ${escapeHtml(v)}</li>`).join('') +
      `</ul>` +
      (body ? `<p><strong>Description:</strong></p><blockquote>${escapeHtml(body)}</blockquote>` : '') +
      (link
        ? `<p><a href="${escapeHtml(link)}">Open the ticket &rarr;</a></p>`
        : `<p>Sign in to the support portal to review and assign this ticket.</p>`) +
      `<p>${brand}<br/><em>Automated Notification</em></p>`;
    const priorityTag = c.priority ? ` (${c.priority})` : '';
    return { subject: `[${number}] New ${kind}${priorityTag}: ${subject}`, html, text };
  },
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
  // CAB voting lifecycle (spec 2026-06-25). No sensitive detail beyond the change's own
  // title/id — never risk/impact narrative, votes, or reasons.
  'change.cab_requested': (c) => {
    const title = c.changeTitle ?? '(untitled change)';
    const deadline = fmtWhen(c.voteDeadline);
    return wrap(`CAB vote requested: ${title}`, [
      `A change is awaiting your CAB vote${c.orgName ? ` for ${c.orgName}` : ''}.`,
      `Change: ${title}`,
      deadline ? `Vote deadline: ${deadline}` : '',
      'Please cast your vote (approve, reject, or abstain) in the portal before the deadline.',
    ].filter(Boolean));
  },
  'change.vote_cast': (c) => {
    const title = c.changeTitle ?? '(untitled change)';
    return wrap(`CAB vote cast: ${title}`, [
      `A board member cast a vote on change "${title}".`,
      'Sign in to the portal to review the current tally.',
    ]);
  },
  'change.approved': (c) => {
    const title = c.changeTitle ?? '(untitled change)';
    return wrap(`Your change was approved: ${title}`, [
      `Good news — your change "${title}" has been approved by the CAB.`,
      'It can now be scheduled for implementation.',
    ]);
  },
  'change.rejected': (c) => {
    const title = c.changeTitle ?? '(untitled change)';
    return wrap(`Your change was not approved: ${title}`, [
      `Your change "${title}" was not approved by the CAB.`,
      'Sign in to the portal to review the board\'s comments, then revise and resubmit if appropriate.',
    ]);
  },
  'change.scheduled': (c) => {
    const title = c.changeTitle ?? '(untitled change)';
    const when = fmtWhen(c.windowStart);
    return wrap(`Your change is scheduled: ${title}`, [
      `Your change "${title}" has been scheduled for implementation.`,
      when ? `Window start: ${when}` : '',
    ].filter(Boolean));
  },
  // The deadline sweeper's escalation (jobs/cab-deadline-sweeper.ts): the vote deadline
  // passed with quorum unmet. This NOTIFIES the chair only — nothing auto-decides the
  // change, so the copy asks the chair to follow up rather than implying any outcome.
  'change.vote_overdue': (c) => {
    const title = c.changeTitle ?? '(untitled change)';
    const deadline = fmtWhen(c.voteDeadline);
    return wrap(`CAB vote overdue: ${title}`, [
      `The CAB vote deadline for change "${title}" has passed and quorum has not been reached.`,
      deadline ? `Deadline was: ${deadline}` : '',
      'As chair, please follow up with the board to secure the remaining votes. No automatic action has been taken on this change.',
    ].filter(Boolean));
  },
};

export function renderTemplate(eventType: string, ctx: TemplateContext): RenderedTemplate {
  const renderer = TEMPLATES[eventType];
  if (renderer) return renderer(ctx);
  return wrap(`Notification for ${ctx.orgName ?? 'your organization'}`, [
    `Event: ${eventType}`,
  ]);
}
