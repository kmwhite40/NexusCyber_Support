import { describe, it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

async function ticketRow(orgId: string, externalRef: string) {
  return withSystemContext(async (sql) =>
    (
      await sql.query(
        `SELECT id, ticket_number, status, assigned_agent_id, external_due_at, external_owner,
                external_source_id, control_ids, external_url, custom_fields
           FROM tickets WHERE organization_id=$1 AND external_ref=$2`,
        [orgId, externalRef],
      )
    ).rows[0],
  );
}

describeDb('integration ticket fields persist through create and upsert', () => {
  let agent: Principal;
  let orgId: string;

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(
      async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  it('persists all five integration columns on create', async () => {
    const externalRef = `int-create-${Date.now()}`;
    await createTicket(agent, {
      subject: 'POA&M remediation',
      organizationId: orgId,
      externalRef,
      externalSource: 'poam',
      integration: {
        dueAt: '2026-11-30T00:00:00.000Z',
        owner: 'Platform Team',
        sourceId: 'p-118',
        controlIds: ['CA-7', 'RA-5'],
        url: 'https://example.gov/applications/urn-1',
      },
    });

    const row = await ticketRow(orgId, externalRef);
    expect(new Date(row.external_due_at).toISOString()).toBe('2026-11-30T00:00:00.000Z');
    expect(row.external_owner).toBe('Platform Team');
    expect(row.external_source_id).toBe('p-118');
    expect(row.control_ids).toEqual(['CA-7', 'RA-5']);
    expect(row.external_url).toBe('https://example.gov/applications/urn-1');
  });

  it('never sets assigned_agent_id from owner', async () => {
    const externalRef = `int-owner-${Date.now()}`;
    await createTicket(agent, {
      subject: 'Owner is text only',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'manager@nexus.example.com' },
    });
    const row = await ticketRow(orgId, externalRef);
    expect(row.external_owner).toBe('manager@nexus.example.com');
    expect(row.assigned_agent_id).toBeNull();
  });

  it('does not clobber status or assignee on re-sync', async () => {
    const externalRef = `int-noclobber-${Date.now()}`;
    const created = await createTicket(agent, {
      subject: 'Reopened finding',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'A' },
    });

    // Simulate Anchor taking ownership and moving the ticket.
    await withSystemContext(async (sql) => {
      await sql.query(
        `UPDATE tickets SET status='in_progress', assigned_agent_id=(SELECT id FROM users WHERE email='manager@nexus.example.com')
          WHERE id=$1`,
        [created.id],
      );
    });

    await createTicket(agent, {
      subject: 'Reopened finding (re-synced)',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'B' },
    });

    const row = await ticketRow(orgId, externalRef);
    expect(row.id).toBe(created.id);
    expect(row.ticket_number).toBe(created.ticket_number);
    expect(row.status).toBe('in_progress');      // Anchor owns the lifecycle
    expect(row.assigned_agent_id).not.toBeNull(); // Anchor owns the assignment
    expect(row.external_owner).toBe('B');         // the caller's text still refreshes
  });

  it('clears external_due_at when dueAt is explicitly null (Review Focus 1)', async () => {
    const externalRef = `int-null-due-${Date.now()}`;
    await createTicket(agent, {
      subject: 'Due date withdrawn',
      organizationId: orgId,
      externalRef,
      integration: { dueAt: '2026-11-30T00:00:00.000Z' },
    });
    // Assert the deadline was really set first: without this, "cleared" and "never written"
    // are the same state and the test would pass against an implementation that stores nothing.
    expect((await ticketRow(orgId, externalRef)).external_due_at).not.toBeNull();

    await createTicket(agent, {
      subject: 'Due date withdrawn',
      organizationId: orgId,
      externalRef,
      integration: { dueAt: null },
    });
    expect((await ticketRow(orgId, externalRef)).external_due_at).toBeNull();
  });

  it('preserves external_due_at when dueAt is absent (Review Focus 1)', async () => {
    const externalRef = `int-absent-due-${Date.now()}`;
    await createTicket(agent, {
      subject: 'Due date kept',
      organizationId: orgId,
      externalRef,
      integration: { dueAt: '2026-11-30T00:00:00.000Z' },
    });
    await createTicket(agent, {
      subject: 'Due date kept',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'unchanged' },
    });
    const row = await ticketRow(orgId, externalRef);
    expect(new Date(row.external_due_at).toISOString()).toBe('2026-11-30T00:00:00.000Z');
  });

  it('clears control_ids on an explicit empty array but preserves it when absent (Review Focus 2)', async () => {
    const externalRef = `int-controls-${Date.now()}`;
    await createTicket(agent, {
      subject: 'Controls',
      organizationId: orgId,
      externalRef,
      integration: { controlIds: ['CA-7'] },
    });

    await createTicket(agent, {
      subject: 'Controls',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'x' },
    });
    expect((await ticketRow(orgId, externalRef)).control_ids).toEqual(['CA-7']);

    await createTicket(agent, {
      subject: 'Controls',
      organizationId: orgId,
      externalRef,
      integration: { controlIds: [] },
    });
    expect((await ticketRow(orgId, externalRef)).control_ids).toEqual([]);
  });
});
