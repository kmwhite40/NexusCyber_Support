import { describe, it, expect } from 'vitest';
import {
  parseCsv, csvRecords, htmlToText, redactSecrets, normalizePerson, personKey, parseLegacyDate,
  mapLegacyRow, mapLegacyChange, extractBackout, legacyNumber,
  legacyRiskRows, mapLegacyRisk, parseControls, splitMitigation,
} from '../src/modules/legacy-ticket-import.js';
import { derivePriority } from '../src/modules/tickets.js';

const TICKET_HEADER = '"ID","Issue Type","Issue Title","Issue description","Priority","Status","Associated files","Related issue","Created","Created By","Notes","Assigned To","Resolution "';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes and newlines inside a field', () => {
    expect(parseCsv('a,"b ""x"" c","line1\nline2"\r\n1,,3\n')).toEqual([['a', 'b "x" c', 'line1\nline2'], ['1', '', '3']]);
  });
  it('keys records by trimmed header (the export has "Resolution " with a trailing space)', () => {
    const [r] = csvRecords(`${TICKET_HEADER}\n"5","Request Fulfillment","T","","Low","Completed","0",,"7/15/2025 11:42 AM","Kernstine, Ben",,"x","done"`);
    expect(r['Resolution']).toBe('done');
    expect(r['Related issue']).toBe('');
  });
});

describe('text cleanup', () => {
  it('turns SharePoint rich text into readable plain text', () => {
    const html = 'When connecting&#58;<p><ol><li>Slow token</li><li>\nHangs</li></ol></p><img src="blob&#58;x" /><a href="https&#58;//x.test/a">link</a>';
    expect(htmlToText(html)).toBe('When connecting:\n• Slow token\n• Hangs\n\nlink (https://x.test/a)');
  });
  it('redacts credentials typed into a ticket', () => {
    expect(redactSecrets('IP: 10.0.0.1\nLogin credentials: Tester/TestAutomation')).toEqual({
      text: 'IP: 10.0.0.1\nLogin credentials: [redacted at import]', redacted: true,
    });
    expect(redactSecrets('reset the password together').redacted).toBe(false);
  });
  it('normalizes "Last, First" and inactive markers, and matches across spacing', () => {
    expect(normalizePerson('<Inactive> Shepherd, Ethan')).toEqual({ name: 'Ethan Shepherd', inactive: true });
    expect(normalizePerson('Dustin O\'Brien')).toEqual({ name: 'Dustin O\'Brien', inactive: false });
    expect(personKey(normalizePerson('De Camp, Barry')!.name)).toBe(personKey('Barry DeCamp'));
  });
  it('reads list timestamps as US Eastern wall-clock, across DST', () => {
    expect(parseLegacyDate('8/26/2026 4:29 AM')).toBe('2026-08-26T08:29:00.000Z'); // EDT
    expect(parseLegacyDate('1/5/2026 12:00 PM')).toBe('2026-01-05T17:00:00.000Z'); // EST
    expect(parseLegacyDate('nope')).toBeNull();
  });
});

describe('mapLegacyRow', () => {
  const row = (over: Record<string, string>) => ({
    ID: '72', 'Issue Type': 'Incident Management', 'Issue Title': 'VPN Unusable', 'Issue description': '<p>slow</p>',
    Priority: 'Critical', Status: 'Completed', 'Associated files': '1', 'Related issue': '', Created: '8/26/2026 4:29 AM',
    'Created By': 'Wise, Taylor', Notes: '', 'Assigned To': '<Inactive> Shepherd, Ethan', Resolution: 'VPN connection resolved.', ...over,
  });
  it('keeps the legacy id as a distinct, threading-safe number', () => {
    const t = mapLegacyRow(row({}));
    expect(t.ticketNumber).toBe('SPL-000072');
    expect(legacyNumber('5')).toBe('SPL-000005');
    expect(t.externalRef).toBe('sharepoint-legacy:FederalSupport/Tickets:72');
  });
  it('maps type and priority so derivePriority reproduces the legacy priority', () => {
    const p = (Priority: string) => { const t = mapLegacyRow(row({ Priority })); return derivePriority(t.impact, t.urgency); };
    expect(['Critical', 'High', 'Normal', 'Low'].map(p)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(mapLegacyRow(row({ 'Issue Type': 'Request Fulfillment' })).type).toBe('service_request');
    expect(mapLegacyRow(row({})).category).toBe('Incident Management');
  });
  it('records people as names and flags attachments the export could not carry', () => {
    const t = mapLegacyRow(row({}));
    expect(t.requesterName).toBe('Taylor Wise');
    expect(t.assignedTo).toEqual(['Ethan Shepherd']);
    expect(t.hadAttachments).toBe(true);
  });
  it('says so when a ticket that was still open is closed by the migration', () => {
    const t = mapLegacyRow(row({ Status: 'In progress', Resolution: '' }));
    expect(t.resolution).toMatch(/^Closed at migration: this ticket was "In progress"/);
  });
  it('refuses rows it cannot date or identify rather than guessing', () => {
    expect(() => mapLegacyRow(row({ Created: '' }))).toThrow(/unparseable Created/);
    expect(() => mapLegacyRow(row({ ID: '' }))).toThrow(/numeric ID/);
  });
});

describe('mapLegacyChange', () => {
  const row = (over: Record<string, string>) => ({
    'Issue ID': '', 'Change Type': 'Software Upgrades', ChangeTitle: 'Enable Safe Links', 'Assigned To': 'White, Kevin;Chau, Kimberly',
    'Issue Status': 'Active', Impact: 'High', 'Due Date': '4/9/2026 12:00 AM', 'Change Status': 'Technical Configuration',
    Description: 'Summary:\nTurn it on\n\nBackout Plan:\nTurn it off\n\nPlanned Implementation Date: 6/15/2025',
    Created: '3/26/2026 10:15 AM', 'Created By': 'Dean, Andrew', 'Responsible Party': '<Inactive> Shepherd, Ethan',
    'Actions Required': '•\tEnable Safe Links', Notes: 'Enable URL rewriting', 'Impacted Controls': 'NIST SI-3', ...over,
  });
  it('carries every legacy field into the description and closes the change', () => {
    const c = mapLegacyChange(row({}));
    expect(c.description).toContain('Legacy status: Active / Technical Configuration');
    expect(c.description).toContain('Due date: 2026-04-09');
    expect(c.description).toContain('Assigned to: Kevin White, Kimberly Chau');
    expect(c.description).toContain('Impacted controls:\nNIST SI-3');
    expect(c.risk).toBe('high');
    expect(c.implementationPlan).toBe('•\tEnable Safe Links');
    expect(c.implementerName).toBe('Ethan Shepherd');
    expect(c.createdByName).toBe('Andrew Dean');
  });
  it('lifts the backout plan out of the free text', () => {
    expect(mapLegacyChange(row({})).backoutPlan).toBe('Turn it off');
    expect(extractBackout('no plan here')).toBeNull();
  });
  it('maps the legacy "(2) Normal" impact to medium and spots emergency changes', () => {
    expect(mapLegacyChange(row({ Impact: '(2) Normal' })).risk).toBe('medium');
    expect(mapLegacyChange(row({ Notes: 'This emergency change is required' })).changeType).toBe('emergency');
    expect(mapLegacyChange(row({})).changeType).toBe('normal');
  });
  it('keys a change by creation instant + title (the export has no id column)', () => {
    const a = mapLegacyChange(row({}));
    const b = mapLegacyChange(row({ ChangeTitle: 'Enable Safe Attachments' }));
    expect(a.externalRef).not.toBe(b.externalRef);
    expect(mapLegacyChange(row({})).externalRef).toBe(a.externalRef);
  });
});

describe('mapLegacyRisk (SBSFederal register workbook)', () => {
  const sheet = [
    'Risk Register,,,,,,,,,,,,,,,',
    'Project Name:,,,SBSFederal,,,,,,,,,,,,',
    'Risk ID,Risk Description,Risk Source,Impact Description,Impacted Controls,Owner,Impact Level,Probability Level,Priority Level,Mitigation Plan,Updated Impact Level,Updated Probability Level,Priority Level,Associated Change ID,Associated Decision ID,Comments',
    'Unique Identifier,Brief summary,,What will happen,Ids,Who,"Rate","Rate",IxP,Steps,"Rate","Rate",IxP,ref,ref,',
    'R007,KeePass for password management,,Creds exposed,IA-05,Compliance,4,2,MODERATE,Reference DHA Risk Assessment,1,1,LOW,,D016,Reviewed and accepted by CCB',
    'R003,STIG Exception: WiFi,,,,IT Department,,,,"""1. Configure Teams rooms. 2. Apply all STIGs""",,,,,"D002, D006",Mitigation item 1 completed; Mitigation item 2 outstanding.',
    'R014,Billing reports to SBSPlanet,Troy,CUI to non-GCCH,,IT Department,3,5,MODERATE,Ask Peraton for exception,0,0,N/A,,,ITEM RESOLVED - removed from blocked list',
  ].join('\n');
  const rows = legacyRiskRows(sheet);
  const [r7, r3, r14] = rows.map(mapLegacyRisk);
  it('skips the title block and guidance row, and reads columns by position', () => {
    expect(rows.map((r) => r[0])).toEqual(['R007', 'R003', 'R014']);
    expect(r7.riskNumber).toBe(7);
  });
  it('maps probability to likelihood and impact to impact, residual from the updated ratings', () => {
    expect(r7.inherent).toEqual({ likelihood: 2, impact: 4 });
    expect(r7.residual).toEqual({ likelihood: 1, impact: 1 });
    expect(r7.status).toBe('monitoring');
    expect(r14.residual).toEqual(r14.inherent); // "0,0,N/A" = not re-rated, not "zero risk"
  });
  it('marks unscored rows instead of pretending they are low', () => {
    expect(r3.unscored).toBe(true);
    expect(r3.status).toBe('identified');
    expect(r3.tags).toEqual(expect.arrayContaining(['needs-assessment', 'D002', 'D006']));
  });
  it('turns numbered mitigation steps into treatments with the status the comments give', () => {
    expect(r3.treatments).toEqual([{ title: 'Configure Teams rooms.', status: 'done' }, { title: 'Apply all STIGs', status: 'in_progress' }]);
    expect(r7.treatments).toEqual([]); // a reference to another document is not a treatment
  });
  it('closes risks the register records as resolved', () => {
    expect(r14.status).toBe('closed');
    expect(r14.treatments.every((t) => t.status === 'done')).toBe(true);
  });
  it('normalizes 800-53 control ids', () => {
    expect(parseControls('"CM-06 AC-02" SC-07(10), CM-03(08)')).toEqual(['CM-6', 'AC-2', 'SC-7(10)', 'CM-3(8)']);
    expect(splitMitigation('Just one step')).toEqual(['Just one step']);
  });
});
