import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createRequest } from '../../src/modules/catalog.js';
import { getTicketForm } from '../../src/modules/ticket-form.js';
import type { Principal } from '../../src/types.js';

// End-to-end: a real onboarding request filed through createRequest, read back through
// getTicketForm. Proves the reassembly against the real seeded form (sections from 0077, the
// security_groups multiselect from 0078), and that PII is revealed only when asked for by a
// pii.view holder — with the pii.viewed audit entry that readSensitive writes.
async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const piiViewedCount = (ticketId: string) =>
  withSystemContext(async (sql) =>
    Number((await sql.query("SELECT count(*) FROM audit_logs WHERE action='pii.viewed' AND resource_id=$1", [ticketId])).rows[0].count),
  );

describeDb('GET /tickets/:id/form reassembly (integration)', () => {
  let customer: Principal;
  let manager: Principal; // ServiceDeskManager — holds pii.view once seeded
  let tier2: Principal; // nexus staff without pii.view
  let ticketId: string;

  beforeAll(async () => {
    customer = await principalByEmail('user@demo.example.com');
    manager = await principalByEmail('manager@nexus.example.com');
    tier2 = await principalByEmail('agent@nexus.example.com');
    const t = await createRequest(customer, 'user.provisioning', {
      answers: {
        on_behalf_of: customer.id,
        start_date: '2026-10-01',
        legal_first_name: 'Grace',
        legal_last_name: 'Hopper',
        access_type: 'Permanent',
        hire_type: 'Direct Hire',
        request_kind: 'New Hire',
        supervisor: customer.id,
        work_location: 'Work from Home - Permanent',
        email_account: 'Create New',
        job_title: 'Rear Admiral',
        personal_email: 'grace@personal.example',
        notes: 'Needs COBOL tooling',
      },
    });
    ticketId = t.id;
  });

  it('seed grants ServiceDeskManager pii.view and provisioning.execute', () => {
    expect(manager.permissions).toEqual(expect.arrayContaining(['pii.view', 'provisioning.execute']));
  });

  it('returns sectioned answers with users resolved and PII withheld by default', async () => {
    const before = await piiViewedCount(ticketId);
    const out = await getTicketForm(manager, ticketId);
    expect(out.form_key).toBe('user_onboarding');
    expect(out.sections.map((s) => s.section)).toContain('The person');
    const all = out.sections.flatMap((s) => s.fields);
    const get = (k: string) => all.find((f) => f.key === k);
    expect(get('legal_first_name')?.display).toBe('Grace');
    expect(get('supervisor')?.display).toMatch(/Alex User <user@demo\.example\.com>/);
    expect(get('on_behalf_of')?.display).toMatch(/user@demo\.example\.com/);
    expect(get('notes')?.display).toBe('Needs COBOL tooling');
    expect(out.requester?.email).toBe('user@demo.example.com');
    expect(out.pii).toBe('withheld');
    expect(get('personal_email')).toMatchObject({ sensitive: true, value: null });
    expect(JSON.stringify(out)).not.toContain('grace@personal.example');
    expect(await piiViewedCount(ticketId)).toBe(before); // no reveal, no audit
  });

  it('reveals PII only for a pii.view holder who asks, and audits the reveal', async () => {
    const before = await piiViewedCount(ticketId);
    const denied = await getTicketForm(tier2, ticketId, { includePii: true });
    expect(denied.pii).toBe('withheld');
    expect(await piiViewedCount(ticketId)).toBe(before);

    const shown = await getTicketForm(manager, ticketId, { includePii: true });
    expect(shown.pii).toBe('included');
    expect(shown.sections.flatMap((s) => s.fields).find((f) => f.key === 'personal_email')?.value).toBe('grace@personal.example');
    expect(await piiViewedCount(ticketId)).toBe(before + 1);
  });

  it('refuses the customer plane', async () => {
    await expect(getTicketForm(customer, ticketId)).rejects.toThrow(/staff/);
  });
});
