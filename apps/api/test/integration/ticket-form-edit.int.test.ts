import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createRequest } from '../../src/modules/catalog.js';
import { editTicketForm } from '../../src/modules/ticket-form-edit.js';
import { submitAnswers } from '../../src/modules/forms.js';
import type { Principal } from '../../src/types.js';

// End-to-end: a real onboarding request filed through createRequest, corrected through
// editTicketForm against the seeded user_onboarding form. Pins the permission, the run/status
// guards, the org check on user answers, the PII gate, and the comment + audit trail.
async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const q = <T = any>(text: string, params: unknown[] = []) =>
  withSystemContext(async (sql) => (await sql.query(text, params)).rows as T[]);

const status = (p: Promise<unknown>) => p.then(() => 200, (e: any) => e.status ?? e);

describeDb('PATCH /tickets/:id/form — editing a submitted request (integration)', () => {
  let customer: Principal;
  let manager: Principal; // ServiceDeskManager — ticket.form.edit + pii.view once seeded
  let tier2: Principal;
  let tier1: Principal;
  let other: Principal; // a second Demo Corp person, to re-point the supervisor at
  let otherOrgId: string;
  let outsiderId: string;

  const file = async (first = 'Grace') =>
    (await createRequest(customer, 'user.provisioning', {
      answers: {
        on_behalf_of: customer.id,
        start_date: '2026-10-01',
        legal_first_name: first,
        legal_last_name: 'Hopper',
        access_type: 'Permanent',
        hire_type: 'Direct Hire',
        request_kind: 'New Hire',
        supervisor: customer.id,
        work_location: 'Work from Home - Permanent',
        email_account: 'Create New',
        personal_email: 'grace@personal.example',
        home_address_street: '1 Navy Way',
      },
    })).id as string;

  beforeAll(async () => {
    customer = await principalByEmail('user@demo.example.com');
    manager = await principalByEmail('manager@nexus.example.com');
    tier2 = await principalByEmail('agent@nexus.example.com');
    tier1 = await principalByEmail('desk1@nexus.example.com');
    other = await principalByEmail('security@demo.example.com');
    otherOrgId = (await q("INSERT INTO organizations (name) VALUES ('Form Edit Other Org ' || gen_random_uuid()) RETURNING id"))[0].id;
    outsiderId = (await q(
      "INSERT INTO users (plane, organization_id, email, display_name) VALUES ('customer',$1,'outsider-' || gen_random_uuid() || '@other.example','Outsider') RETURNING id",
      [otherOrgId],
    ))[0].id;
  });

  afterAll(async () => {
    if (otherOrgId) await q('DELETE FROM organizations WHERE id=$1', [otherOrgId]);
  });

  it('seed grants ticket.form.edit to ServiceDeskManager only', () => {
    expect(manager.permissions).toContain('ticket.form.edit');
    expect(tier2.permissions).not.toContain('ticket.form.edit');
    expect(tier1.permissions).not.toContain('ticket.form.edit');
  });

  it('lets a ServiceDeskManager correct answers; mapped fields land where they live; comment + audit written', async () => {
    const id = await file();
    const out = await editTicketForm(manager, id, {
      legal_first_name: 'Grayce',
      supervisor: other.id,
      start_date: '2026-10-15',
      notes: 'Corrected by HR',
    }, { reason: 'HR sent the wrong spelling' });

    const all = out.sections.flatMap((s) => s.fields);
    expect(all.find((f) => f.key === 'legal_first_name')?.value).toBe('Grayce');
    expect(all.find((f) => f.key === 'start_date')?.value).toBe('2026-10-15');

    const [t] = await q('SELECT subject, description, custom_fields FROM tickets WHERE id=$1', [id]);
    expect(t.subject).toBe('Grayce Hopper'); // recomposed from the name fields
    expect(t.description).toBe('Corrected by HR');
    expect(t.custom_fields.supervisor).toBe(other.id); // manager stays in custom_fields
    expect(t.custom_fields.legal_first_name).toBe('Grayce');

    const comments = await q("SELECT body FROM ticket_comments WHERE ticket_id=$1 AND visibility='internal'", [id]);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toMatch(/Reason: HR sent the wrong spelling/);
    expect(comments[0].body).toMatch(/Grace → Grayce/);
    expect(comments[0].body).toMatch(/Start date.*2026-10-01 → 2026-10-15/);

    const audits = await q("SELECT detail FROM audit_logs WHERE action='ticket.form.edited' AND resource_id=$1", [id]);
    expect(audits).toHaveLength(1);
    expect(audits[0].detail.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'legal_first_name', from: 'Grace', to: 'Grayce' }),
    ]));
  });

  it('refuses holders of ticket.update without ticket.form.edit (Tier2, Tier1)', async () => {
    const id = await file();
    expect(await status(editTicketForm(tier2, id, { start_date: '2026-11-01' }))).toBe(403);
    expect(await status(editTicketForm(tier1, id, { start_date: '2026-11-01' }))).toBe(403);
    expect(await status(editTicketForm(customer, id, { start_date: '2026-11-01' }))).toBe(403);
  });

  it('refuses a resolved ticket', async () => {
    const id = await file();
    await q("UPDATE tickets SET status='resolved' WHERE id=$1", [id]);
    await expect(editTicketForm(manager, id, { start_date: '2026-11-01' })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses while a provisioning run is in flight, and pins the name once the account exists', async () => {
    const id = await file();
    const [run] = await q(
      "INSERT INTO provisioning_runs (ticket_id, organization_id, kind, status) SELECT id, organization_id, 'onboarding', 'running' FROM tickets WHERE id=$1 RETURNING id",
      [id],
    );
    await expect(editTicketForm(manager, id, { start_date: '2026-11-01' })).rejects.toMatchObject({
      status: 409, message: expect.stringMatching(/provisioning is in progress/i),
    });

    await q("UPDATE provisioning_runs SET status='succeeded', finished_at=now() WHERE id=$1", [run.id]);
    await expect(editTicketForm(manager, id, { legal_last_name: 'Murray' })).rejects.toMatchObject({
      status: 409, message: expect.stringMatching(/already been created/i),
    });
    // Other answers stay correctable after the account exists.
    await expect(editTicketForm(manager, id, { start_date: '2026-11-01' })).resolves.toBeTruthy();
  });

  it('refuses a user answer from another organization', async () => {
    const id = await file();
    await expect(editTicketForm(manager, id, { supervisor: outsiderId })).rejects.toMatchObject({
      status: 422, errors: [expect.objectContaining({ field: 'supervisor' })],
    });
    const [t] = await q('SELECT custom_fields FROM tickets WHERE id=$1', [id]);
    expect(t.custom_fields.supervisor).toBe(customer.id);
  });

  it('refuses approver changes, and validation failures, without writing', async () => {
    const id = await file();
    await expect(editTicketForm(manager, id, { approvers: [customer.id] })).rejects.toMatchObject({ status: 409 });
    await expect(editTicketForm(manager, id, { legal_last_name: '' })).rejects.toMatchObject({ status: 422 });
    await expect(editTicketForm(manager, id, { start_date: 'next tuesday' })).rejects.toMatchObject({ status: 422 });
    // Switching to Temporary makes end_date required.
    await expect(editTicketForm(manager, id, { access_type: 'Temporary' })).rejects.toMatchObject({
      status: 422, errors: [expect.objectContaining({ field: 'end_date' })],
    });
    expect(await q("SELECT 1 FROM ticket_comments WHERE ticket_id=$1 AND visibility='internal'", [id])).toHaveLength(0);
  });

  it('gates PII edits on pii.view, writes them to the sensitive store only, and never records the value', async () => {
    const id = await file();
    const noPii: Principal = { ...manager, permissions: manager.permissions.filter((p) => p !== 'pii.view') };
    expect(await status(editTicketForm(noPii, id, { personal_email: 'new@personal.example' }))).toBe(403);

    await editTicketForm(manager, id, { personal_email: 'new@personal.example' }, { reason: 'typo' });
    const [s] = await q("SELECT value FROM ticket_sensitive_fields WHERE ticket_id=$1 AND key='personal_email'", [id]);
    expect(s.value).toBe('new@personal.example');
    const [t] = await q('SELECT custom_fields FROM tickets WHERE id=$1', [id]);
    expect(t.custom_fields).not.toHaveProperty('personal_email');
    const [c] = await q("SELECT body FROM ticket_comments WHERE ticket_id=$1 AND visibility='internal'", [id]);
    expect(c.body).toMatch(/Personal email.*changed/i);
    const [a] = await q("SELECT detail FROM audit_logs WHERE action='ticket.form.edited' AND resource_id=$1", [id]);
    expect(JSON.stringify(a.detail)).not.toContain('new@personal.example');
    expect(c.body).not.toContain('new@personal.example');
  });

  it('removes a PII answer whose condition an edit turns off', async () => {
    const id = await file();
    await editTicketForm(manager, id, { work_location: 'On Site' });
    const rows = await q("SELECT key FROM ticket_sensitive_fields WHERE ticket_id=$1 AND key='home_address_street'", [id]);
    expect(rows).toHaveLength(0);
  });

  it('closes the legacy form-answers hole: a filed request cannot be overwritten through it', async () => {
    const id = await file();
    const [form] = await q("SELECT id FROM request_forms WHERE key='user_onboarding' AND organization_id IS NULL");
    await expect(submitAnswers(tier1, id, form.id, { legal_first_name: 'Mallory' })).rejects.toMatchObject({ status: 409 });
    const [t] = await q('SELECT custom_fields FROM tickets WHERE id=$1', [id]);
    expect(t.custom_fields.legal_first_name).toBe('Grace');
  });
});
