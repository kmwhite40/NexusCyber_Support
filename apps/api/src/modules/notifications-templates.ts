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
  'ticket.assigned': (c) =>
    wrap(`[${c.ticketNumber}] Ticket assigned`, [
      `Ticket ${c.ticketNumber} was assigned.`,
      `Subject: ${c.subject ?? ''}`,
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
