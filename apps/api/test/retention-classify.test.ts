import { describe, it, expect } from 'vitest';
import { classifyRetention, retainUntil } from '../src/modules/retention/classify.js';

const none = { directoryRoleCount: 0, nexusPermissions: [], elevationGrants: [] };

describe('classifyRetention', () => {
  it('is standard with no evidence of privilege', () => {
    expect(classifyRetention(none).retentionClass).toBe('standard');
  });

  it('is privileged on an Entra directory role', () => {
    expect(classifyRetention({ ...none, directoryRoleCount: 1 }).retentionClass).toBe('privileged');
  });

  it('is privileged on a privileged Nexus permission', () => {
    expect(classifyRetention({ ...none, nexusPermissions: ['cab.manage'] }).retentionClass).toBe('privileged');
  });

  it('is NOT privileged on an ordinary Nexus permission', () => {
    // Otherwise every account would be privileged and the distinction would mean nothing.
    expect(classifyRetention({ ...none, nexusPermissions: ['ticket.create', 'kb.read'] }).retentionClass)
      .toBe('standard');
  });

  it('is privileged on an EXPIRED elevation grant', () => {
    // The grant's current status is irrelevant: if they ever held elevation, the privilege
    // existed. Filtering to active grants would silently downgrade exactly the people the
    // seven-year rule targets — and invisibly, since their access is already gone.
    expect(classifyRetention({
      ...none,
      elevationGrants: [{ status: 'expired', break_glass: false, granted_permissions: ['admin.superuser'] }],
    }).retentionClass).toBe('privileged');
  });

  it('is privileged on a REVOKED elevation grant', () => {
    expect(classifyRetention({
      ...none,
      elevationGrants: [{ status: 'revoked', break_glass: false, granted_permissions: ['x'] }],
    }).retentionClass).toBe('privileged');
  });

  it('is privileged on a break-glass grant', () => {
    expect(classifyRetention({
      ...none,
      elevationGrants: [{ status: 'expired', break_glass: true, granted_permissions: ['admin.superuser'] }],
    }).retentionClass).toBe('privileged');
  });

  it('records WHY it is privileged', () => {
    const c = classifyRetention({
      directoryRoleCount: 2, nexusPermissions: ['cab.manage', 'ticket.create'], elevationGrants: [],
    });
    expect(c.basis).toMatchObject({ directoryRoleCount: 2, nexusPermissions: ['cab.manage'] });
  });

  it('records an empty basis for a standard account rather than omitting it', () => {
    // An auditor asking "why is this one only a year?" should get an answer too.
    const c = classifyRetention(none);
    expect(c.basis).toMatchObject({ directoryRoleCount: 0, nexusPermissions: [], elevationGrants: [] });
  });
});

describe('retainUntil', () => {
  it('is one year out for a standard account', () => {
    expect(retainUntil(new Date('2026-09-02T12:00:00Z'), 'standard').toISOString())
      .toBe('2027-09-02T12:00:00.000Z');
  });

  it('is seven years out for a privileged account', () => {
    expect(retainUntil(new Date('2026-09-02T12:00:00Z'), 'privileged').toISOString())
      .toBe('2033-09-02T12:00:00.000Z');
  });

  it('clamps a leap day instead of drifting into March', () => {
    // 2028 is a leap year, 2029 is not. Feb 29 + 1 year must land on Feb 28 — a retention date
    // that silently drifts is one nobody can reconcile against a record years later.
    expect(retainUntil(new Date('2028-02-29T00:00:00Z'), 'standard').toISOString().slice(0, 10))
      .toBe('2029-02-28');
  });

  it('keeps a leap day when the target year is also a leap year', () => {
    expect(retainUntil(new Date('2028-02-29T00:00:00Z'), 'privileged').toISOString().slice(0, 10))
      .toBe('2035-02-28');
  });

  it('does not mutate the date it was given', () => {
    const input = new Date('2026-09-02T12:00:00Z');
    retainUntil(input, 'privileged');
    expect(input.toISOString()).toBe('2026-09-02T12:00:00.000Z');
  });
});

// "Any evidence of privilege ever" means privilege they HELD. A request that was refused is
// evidence of the opposite, and counting it produced a seven-year federal record for someone who
// was told no — contradicting the rationale written directly above the function.
describe('classifyRetention — a refused request is not privilege', () => {
  const grant = (status: string) => ({
    ...none, elevationGrants: [{ status, break_glass: false, granted_permissions: ['admin.superuser'] }],
  });

  it('does NOT count a rejected elevation request', () => {
    expect(classifyRetention(grant('rejected')).retentionClass).toBe('standard');
  });

  it('does NOT count an elevation request still awaiting a decision', () => {
    expect(classifyRetention(grant('requested')).retentionClass).toBe('standard');
  });

  it('DOES count active, expired and revoked — privilege that was actually held', () => {
    for (const status of ['active', 'expired', 'revoked']) {
      expect(classifyRetention(grant(status)).retentionClass).toBe('privileged');
    }
  });

  it('records only the grants that counted, so the basis explains the decision', () => {
    const c = classifyRetention({
      ...none,
      elevationGrants: [
        { status: 'rejected', break_glass: false, granted_permissions: ['a'] },
        { status: 'expired', break_glass: false, granted_permissions: ['b'] },
      ],
    });
    expect((c.basis.elevationGrants as unknown[]).length).toBe(1);
  });
});
