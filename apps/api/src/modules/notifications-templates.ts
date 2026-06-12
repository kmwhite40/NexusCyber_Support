// Per-event notification templates (docs/nexus/06 §K.3 template engine).
// A small TS map keeps us dependency-free; tenant branding (org name / from-name)
// is threaded through the context. i18n keys are future work.

export interface TemplateContext {
  orgName?: string;
  ticketNumber?: string;
  subject?: string;
  metric?: string;
  severity?: string;
  [k: string]: unknown;
}

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

function wrap(title: string, lines: string[]): RenderedTemplate {
  const text = [title, '', ...lines].join('\n');
  const html =
    `<h2>${title}</h2>` + lines.map((l) => `<p>${l}</p>`).join('');
  return { subject: title, html, text };
}

type Renderer = (c: TemplateContext) => RenderedTemplate;

const TEMPLATES: Record<string, Renderer> = {
  'ticket.created': (c) =>
    wrap(`[${c.ticketNumber}] New ticket: ${c.subject ?? ''}`, [
      `A new ticket was created for ${c.orgName ?? 'your organization'}.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
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
