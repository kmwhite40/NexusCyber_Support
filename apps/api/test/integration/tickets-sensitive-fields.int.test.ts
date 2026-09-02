import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket } from '../../src/modules/tickets.js';
import { ApiError } from '../../src/errors.js';
import type { Principal } from '../../src/types.js';

// End-to-end proof, against real Postgres, that the M2M / external-GRC integration path
// (createTicket, migration 0051) cannot smuggle PII-shaped keys into tickets.custom_fields.
// Unlike the catalog intake path (test/integration/catalog-onboarding-pii.int.test.ts), this
// path has no form to consult; the guard instead reads form_fields.sensitive to build a
// deny-list of key names (see rejectSensitiveCustomFields, unit-tested DB-free in
// test/tickets-sensitive-fields.test.ts). This suite proves the DB-backed wiring: an actual
// query against the seeded 0054 fields, actually enforced inside createTicket.
async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('createTicket rejects reserved sensitive keys in customFields (integration)', () => {
  let agent: Principal; // nexus-plane, has ticket.create, stands in for the M2M actor
  let acmeId: string;

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id);
  });

  it('refuses (422) a fresh-insert ticket whose customFields carries a known-sensitive key', async () => {
    await expect(
      createTicket(agent, {
        subject: 'Sync from external GRC',
        organizationId: acmeId,
        externalRef: `grc-refuse-${Date.now()}`,
        externalSource: 'test-grc',
        customFields: { vendor_id: 'V-1', personal_email: 'leak@personal.example' },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('makes no write when refused — the ticket is not created under externalRef', async () => {
    const externalRef = `grc-no-write-${Date.now()}`;
    await expect(
      createTicket(agent, {
        subject: 'Sync from external GRC',
        organizationId: acmeId,
        externalRef,
        customFields: { cell_phone: '555-0100' },
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const row = await withSystemContext(async (sql) =>
      (await sql.query('SELECT id FROM tickets WHERE organization_id=$1 AND external_ref=$2', [acmeId, externalRef])).rows[0],
    );
    expect(row).toBeUndefined();
  });

  it('allows non-colliding customFields through unaffected (no regression)', async () => {
    const externalRef = `grc-ok-${Date.now()}`;
    const ticket = await createTicket(agent, {
      subject: 'Sync from external GRC',
      organizationId: acmeId,
      externalRef,
      externalSource: 'test-grc',
      customFields: { vendor_ticket_id: 'V-42', severity_note: 'p2' },
    });
    expect(ticket.matched).toBe(false);
    expect(ticket.custom_fields).toMatchObject({ vendor_ticket_id: 'V-42', severity_note: 'p2' });
  });

  it('still refuses on the idempotent-upsert (repeat externalRef) branch, not just fresh insert', async () => {
    const externalRef = `grc-upsert-refuse-${Date.now()}`;
    // First sync: clean, succeeds and creates the ticket.
    const created = await createTicket(agent, {
      subject: 'Sync from external GRC',
      organizationId: acmeId,
      externalRef,
      externalSource: 'test-grc',
      customFields: { vendor_ticket_id: 'V-1' },
    });
    expect(created.matched).toBe(false);

    // Re-sync of the SAME item now carries a sensitive key — must be refused, and must not
    // clobber the existing row's custom_fields via the UPDATE branch.
    await expect(
      createTicket(agent, {
        subject: 'Sync from external GRC (updated)',
        organizationId: acmeId,
        externalRef,
        externalSource: 'test-grc',
        customFields: { vendor_ticket_id: 'V-1', personal_email: 'leak@personal.example' },
      }),
    ).rejects.toMatchObject({ status: 422 });

    const row = await withSystemContext(async (sql) =>
      (await sql.query('SELECT custom_fields FROM tickets WHERE id=$1', [created.id])).rows[0],
    );
    expect(row.custom_fields).toEqual({ vendor_ticket_id: 'V-1' });
  });

  it('a clean re-sync of the same externalRef still updates in place (idempotency preserved)', async () => {
    const externalRef = `grc-upsert-ok-${Date.now()}`;
    const created = await createTicket(agent, {
      subject: 'Sync from external GRC',
      organizationId: acmeId,
      externalRef,
      externalSource: 'test-grc',
      customFields: { vendor_ticket_id: 'V-9' },
    });
    const resynced = await createTicket(agent, {
      subject: 'Sync from external GRC (updated)',
      organizationId: acmeId,
      externalRef,
      externalSource: 'test-grc',
      customFields: { vendor_ticket_id: 'V-9', status_note: 'closed upstream' },
    });
    expect(resynced.matched).toBe(true);
    expect(resynced.id).toBe(created.id);
    expect(resynced.subject).toBe('Sync from external GRC (updated)');
    expect(resynced.custom_fields).toMatchObject({ vendor_ticket_id: 'V-9', status_note: 'closed upstream' });
  });
});
