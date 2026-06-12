import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listForms, getForm, submitAnswers } from '../../src/modules/forms.js';
import { createTicket } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('custom request forms (integration)', () => {
  let agent: Principal;
  let acmeId: string;
  let formId: string;

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Acme'")).rows[0].id);
  });

  it('lists the seeded global form and loads its fields', async () => {
    const list = await listForms(agent);
    const f = list.find((x: any) => x.key === 'new_user_access');
    expect(f).toBeTruthy();
    formId = f.id;
    const full = await getForm(agent, formId);
    expect(full.fields.map((ff: any) => ff.key)).toContain('department');
  });

  it('validates and stores answers on the ticket custom_fields', async () => {
    const t = await createTicket(agent, { type: 'access_request', subject: 'New hire access', organizationId: acmeId, impact: 3, urgency: 3 });

    // Missing required field -> validation error.
    await expect(submitAnswers(agent, t.id, formId, { department: 'Engineering' })).rejects.toThrow(/required/i);

    // Complete, valid submission persists into custom_fields.
    const res = await submitAnswers(agent, t.id, formId, {
      full_name: 'Jordan New',
      department: 'Engineering',
      start_date: '2026-08-01',
      manager_email: 'mgr@acme.example.com',
      needs_admin: false,
    });
    expect(res.ok).toBe(true);
    expect(res.custom_fields.full_name).toBe('Jordan New');

    const stored = await withSystemContext(async (sql) =>
      (await sql.query('SELECT custom_fields FROM tickets WHERE id=$1', [t.id])).rows[0].custom_fields,
    );
    expect(stored.department).toBe('Engineering');
  });
});
