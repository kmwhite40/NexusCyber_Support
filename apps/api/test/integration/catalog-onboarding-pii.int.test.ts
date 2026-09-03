import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createRequest } from '../../src/modules/catalog.js';
import type { Principal } from '../../src/types.js';

// End-to-end proof for the PII guarantee on the PRIMARY intake path — POST /catalog/:key/request
// -> createRequest. The pure decision (planRequestWrite) is covered DB-free in
// catalog-request-pii.test.ts; this asserts the row that actually lands in Postgres.
const SENSITIVE_KEYS = ['personal_email', 'cell_phone', 'home_address_street', 'home_address_csz'];

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('onboarding request PII routing (integration)', () => {
  let customer: Principal;

  beforeAll(async () => {
    customer = await principalByEmail('user@demo.example.com');
  });

  it('routes PII to ticket_sensitive_fields and never into tickets.custom_fields', async () => {
    const pii = {
      personal_email: 'john.doe@personal.example',
      cell_phone: '(555) 123-4567',
      home_address_street: '1 Main St',
      home_address_csz: 'Springfield, VA 22150',
    };
    const ticket = await createRequest(customer, 'user.provisioning', {
      answers: {
        on_behalf_of: customer.id,
        start_date: '2026-10-01',
        legal_first_name: 'John',
        legal_last_name: 'Doe',
        access_type: 'Permanent',
        hire_type: 'Direct Hire',
        request_kind: 'New Hire',
        supervisor: customer.id,
        work_location: 'Work from Home - Permanent',
        email_account: 'Create New',
        job_title: 'Analyst',
        ...pii,
      },
    });

    const stored = await withSystemContext(async (sql) => {
      const t = (await sql.query('SELECT subject, custom_fields FROM tickets WHERE id=$1', [ticket.id])).rows[0];
      const s = (await sql.query('SELECT key, value FROM ticket_sensitive_fields WHERE ticket_id=$1 ORDER BY key', [ticket.id])).rows;
      return { t, s };
    });

    // 1. No sensitive key, and no sensitive VALUE, anywhere in the custom_fields blob —
    //    which tickets.ts returns wholesale and which feeds webhooks/notifications.
    const blob = JSON.stringify(stored.t.custom_fields);
    for (const k of SENSITIVE_KEYS) expect(stored.t.custom_fields).not.toHaveProperty(k);
    for (const v of Object.values(pii)) expect(blob).not.toContain(v);
    // 2. The non-sensitive answers are still there.
    expect(stored.t.custom_fields).toMatchObject({
      job_title: 'Analyst', _form: 'user_onboarding',
      legal_first_name: 'John', legal_last_name: 'Doe', // Phase 2's planner reads these back
    });
    // 3. The PII is in the permission-gated store instead, committed with the ticket.
    expect(Object.fromEntries(stored.s.map((r: { key: string; value: string }) => [r.key, r.value]))).toEqual(pii);
    // 4. The subject is a full name, not a bare first name (0055).
    expect(stored.t.subject).toBe('John Doe');
  });

  it('does not persist a hidden field answer, in either store', async () => {
    const ticket = await createRequest(customer, 'user.provisioning', {
      answers: {
        on_behalf_of: customer.id,
        start_date: '2026-10-01',
        legal_first_name: 'Ada', legal_last_name: 'Byron',
        access_type: 'Permanent', hire_type: 'Direct Hire', request_kind: 'New Hire',
        supervisor: customer.id,
        work_location: 'On Site', // hides both home-address fields
        email_account: 'Create New',
        // A direct API client posting hidden answers anyway. validateAgainstForm skips
        // hidden fields, so these are never validated — they must never be persisted.
        home_address_street: '1 Main St',
        home_address_csz: 'Springfield, VA 22150',
      },
    });

    const stored = await withSystemContext(async (sql) => {
      const t = (await sql.query('SELECT custom_fields FROM tickets WHERE id=$1', [ticket.id])).rows[0];
      const s = (await sql.query('SELECT key FROM ticket_sensitive_fields WHERE ticket_id=$1', [ticket.id])).rows;
      return { t, s };
    });

    expect(stored.t.custom_fields).not.toHaveProperty('home_address_street');
    expect(stored.t.custom_fields).not.toHaveProperty('home_address_csz');
    expect(stored.s.map((r: { key: string }) => r.key)).toEqual([]);
    expect(JSON.stringify(stored.t.custom_fields)).not.toContain('1 Main St');
  });
});
