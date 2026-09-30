import { describe, it, expect } from 'vitest';
import { renderOnboardingGuide, endpointsFor, type OnboardingGuideInput } from '../src/modules/provisioning/onboarding-guide.js';

const base: OnboardingGuideInput = {
  fullName: 'Mike Baldwin',
  department: 'Federal Programs',
  upn: 'mike.baldwin@sbsfederal.com',
  credential: 'Xy7!pass-9Q',
  kind: 'password',
  cloud: 'gcchigh',
  cloudPcAssigned: true,
  issuedOn: new Date('2026-09-30T14:00:00Z'),
  supervisorName: 'Mike Rohan',
  helpdesk: { email: 'anchor-support@sbsfederal.com', portal: 'https://anchor.azurewebsites.us' },
};

describe('SBS onboarding guide', () => {
  it('fills every placeholder from the template', () => {
    const { html, text, subject } = renderOnboardingGuide(base);
    for (const out of [html, text]) {
      expect(out).not.toMatch(/\[(FULL NAME|DEPARTMENT|DATE|username@|TEMPORARY PASSWORD|COMMERCIAL|ASSIGNED|HELPDESK|SERVICE DESK|SUPPORT HOURS)/);
      expect(out).toContain('Mike Baldwin');
      expect(out).toContain('mike.baldwin@sbsfederal.com');
      expect(out).toContain('Federal Programs');
      expect(out).toContain('September 30, 2026');
      expect(out).toContain('Xy7!pass-9Q');
    }
    expect(subject).toBe('SBS Microsoft 365 Onboarding Guide — Mike Baldwin (mike.baldwin@sbsfederal.com)');
  });

  it('shows only the GCC High endpoints for a GCC High tenant, and ticks the right boxes', () => {
    const { text } = renderOnboardingGuide(base);
    expect(text).toContain('https://portal.office365.us');
    expect(text).toContain('https://outlook.office365.us');
    expect(text).not.toContain('https://outlook.office.com');
    expect(text).toContain('☐ Commercial  ☒ GCC High');
    expect(text).toContain('☒ Assigned  ☐ Not Assigned');
  });

  it('uses the commercial endpoints for commercial and GCC tenants', () => {
    expect(endpointsFor('commercial').outlook).toBe('https://outlook.office.com');
    expect(endpointsFor('gcc').portal).toBe('https://m365.cloud.microsoft');
    const { text } = renderOnboardingGuide({ ...base, cloud: 'commercial' });
    expect(text).toContain('☒ Commercial  ☐ GCC High');
    expect(text).not.toContain('office365.us');
  });

  it('drops the Cloud PC sections when none was assigned', () => {
    const { text } = renderOnboardingGuide({ ...base, cloudPcAssigned: false });
    expect(text).not.toContain('https://windows.cloud.microsoft');
    expect(text).toContain('☐ Assigned  ☒ Not Assigned');
    expect(text).toContain('No Windows 365 Cloud PC has been assigned');
  });

  it('words a Temporary Access Pass as single-use with its lifetime, not as a password to change', () => {
    const { text } = renderOnboardingGuide({ ...base, kind: 'tap', tapLifetime: '8 hours' });
    expect(text).toContain('Temporary Access Pass: Xy7!pass-9Q');
    expect(text).toContain('expires in 8 hours');
    expect(text).not.toContain('Temporary password changed');
  });

  it('escapes every filled value in the HTML', () => {
    const { html } = renderOnboardingGuide({ ...base, fullName: '<script>x</script>', department: 'R&D "Ops"', credential: '<b>&' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('R&amp;D &quot;Ops&quot;');
    expect(html).toContain('&lt;b&gt;&amp;');
  });

  it('omits help desk lines that are not configured', () => {
    const { text } = renderOnboardingGuide({ ...base, helpdesk: { email: 'it@x.gov' } });
    expect(text).toContain('Email: mailto:it@x.gov');
    expect(text).not.toContain('Phone:');
    expect(text).not.toContain('Support Hours:');
  });

  it('declares UTF-8 so the checkboxes and dashes do not render as mojibake', () => {
    expect(renderOnboardingGuide(base).html).toMatch(/^<!doctype html><html><head><meta charset="utf-8">/);
  });

  it('tells the supervisor not to forward it', () => {
    const { text } = renderOnboardingGuide(base);
    expect(text).toMatch(/For Mike Rohan:.*Do not forward this email/s);
  });
});
