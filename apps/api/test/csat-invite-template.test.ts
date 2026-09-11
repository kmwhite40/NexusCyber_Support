import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../src/modules/notifications-templates.js';

// The invite used to link to /tickets/{id} — a page behind the login wall. The whole point of
// emailing a survey is that answering it costs one click; asking an end user to authenticate
// first is why so few of them ever came back.
describe('the CSAT invite', () => {
  const base = { ticketNumber: 'STRA-000006', subject: 'Laptop will not boot', webOrigin: 'https://anchor.example.us', ticketId: 't-1' };

  it('links to the public survey, not to the portal', () => {
    const r = renderTemplate('csat.survey_created', { ...base, surveyToken: 'TOKEN123456789012345678' })!;
    expect(r.html).toContain('https://anchor.example.us/survey/TOKEN123456789012345678');
    expect(r.text).toContain('https://anchor.example.us/survey/TOKEN123456789012345678');
    expect(r.html).not.toContain('/tickets/t-1');
  });

  // Surveys created in the portal carry no token, and a link with an empty one goes to a page
  // that can only say "unknown". Say the true thing instead.
  it('falls back to the portal when there is no token', () => {
    const r = renderTemplate('csat.survey_created', base)!;
    expect(r.html).not.toContain('/survey/');
    expect(r.html.toLowerCase()).toContain('sign in');
  });

  // The link IS the credential, so it must not be dressed up as anything else, and the mail must
  // not invite forwarding.
  it('warns that the link is personal to the recipient', () => {
    const r = renderTemplate('csat.survey_created', { ...base, surveyToken: 'TOKEN123456789012345678' })!;
    expect(r.text.toLowerCase()).toMatch(/do not forward|personal to you|meant for you/);
  });

  it('says how long the link lasts', () => {
    const r = renderTemplate('csat.survey_created', { ...base, surveyToken: 'TOKEN123456789012345678' })!;
    expect(r.text).toMatch(/30 days/);
  });
});
