import { describe, it, expect } from 'vitest';
import { gdapRisks, parseTreatments, parseControlMapping } from '../src/modules/gdap-risk-import.js';

const HEADER = 'Title,Because of (cause),This may happen (event),Leading to (consequence),Category,Threat source,Response strategy,Velocity,Inherent likelihood,Inherent impact,Residual likelihood,Residual impact,Target likelihood,Target impact,Confidentiality,Integrity,Availability,Financial,Operational,Reputational,Compliance,Safety,Owner (name),Review every (days),Tags,Description';

const DESC = `[GDAP-SBS-02] Tenant: SBS Federal (sbsfederal.com, D0529DA6-C9FD-44EC-9F40-0163E305FA90). Nexus technicians sign in from unmanaged devices.

Evidence: Applied 2026-11-09.

Treatment plan: (1) Quarterly review of service-provider sign-ins; confirm exclusions still target Nexus only. Owner: Tenant ISSO; target First review 2027-02-24. (2) Authorizing Official acceptance of the exception: RA-2026-03 (proposed). Owner: ISSO / Authorizing Official; target 2026-12-31.

Control mapping: AC.L1-3.1.1; AC.L2-3.1.12; AC-17. Identified 2026-11-24. Source: SBS-GRC-RR-GDAP v1.0.`;

const ROW = ['GDAP-SBS-02: Partner administration exempt from device compliance (SBS Federal)', 'Nexus technicians are excluded', 'a technician signs in from an unmanaged device', 'admin session on an uncontrolled device',
  'Third party', 'Adversarial', 'Accept', 'Days', 'Possible', 'Moderate', 'Unlikely', 'Moderate', 'Rare', 'Minor',
  'Moderate', 'Moderate', 'Minor', 'Negligible', 'N/A', 'Moderate', 'Major', 'N/A', 'SBS Federal ISSO', '90', 'gdap, gcch, cmmc', DESC]
  .map((c) => `"${c.replace(/"/g, '""')}"`).join(',');

describe('gdap risk register import', () => {
  const [r] = gdapRisks(`${HEADER}\n${ROW}\n`);

  it('routes the row by the tenant id named in the description, lower-cased', () => {
    expect(r.registerId).toBe('GDAP-SBS-02');
    expect(r.tenantId).toBe('d0529da6-c9fd-44ec-9f40-0163e305fa90');
    expect(r.tenantName).toBe('SBS Federal');
  });

  it('maps labels onto the 1-5 scales and the form enums', () => {
    expect(r.inherent).toEqual({ likelihood: 3, impact: 3 });
    expect(r.residual).toEqual({ likelihood: 2, impact: 3 });
    expect(r.target).toEqual({ likelihood: 1, impact: 2 });
    expect(r.category).toBe('third_party');
    expect(r.threatSource).toBe('adversarial');
    expect(r.strategy).toBe('accept');
    expect(r.velocity).toBe('rapid');
  });

  it('drops N/A impact dimensions instead of scoring them', () => {
    expect(r.impactDimensions).toEqual({ confidentiality: 3, integrity: 3, availability: 2, financial: 1, reputational: 3, compliance: 4 });
  });

  it('splits the treatment plan into dated items and keeps the control refs', () => {
    expect(r.treatments.map((t) => [t.ownerName, t.dueAt])).toEqual([['Tenant ISSO', '2027-02-24'], ['ISSO / Authorizing Official', '2026-12-31']]);
    expect(r.treatments[0].title).toBe('Quarterly review of service-provider sign-ins; confirm exclusions still target Nexus only');
    expect(r.controls).toEqual(['AC.L1-3.1.1', 'AC.L2-3.1.12', 'AC-17']);
    expect(r.tags).toEqual(['gdap', 'gcch', 'cmmc']);
  });

  it('refuses a row with no tenant id rather than guessing an organization', () => {
    const bad = ROW.replace(/\(sbsfederal\.com, [^)]+\)/, '(sbsfederal.com)');
    expect(() => gdapRisks(`${HEADER}\n${bad}\n`)).toThrow(/no "Tenant/);
  });

  it('parses plans and mappings on their own', () => {
    expect(parseTreatments('no plan here')).toEqual([]);
    expect(parseControlMapping('Control mapping: CP-2; SA-9. Identified 2026-11-24.')).toEqual(['CP-2', 'SA-9']);
  });
});
