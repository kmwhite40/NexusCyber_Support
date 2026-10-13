import { describe, it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';
import { upsertIntegrationTicket } from '../../src/modules/integration-tickets.js';
import { buildKeyPrincipal } from '../../src/auth/api-key.js';

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

describeDb('upsertIntegrationTicket end to end', () => {
  let agent: Principal;
  let orgId: string;
  // A well-formed uuid that is deliberately NOT a seeded organization. createTicket calls
  // authorize() before it opens any DB context, so the PDP rejects this with 403 before a
  // foreign key could ever be checked — which is exactly the boundary under test.
  const foreignOrgId = '00000000-0000-4000-8000-00000000dead';

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(
      async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  function body(over: Record<string, unknown> = {}) {
    return {
      externalRef: `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      organizationId: orgId,
      source: 'poam',
      title: 'Patch CVE-2026-1234',
      severity: 'high',
      status: 'open',
      priority: 'P1',
      tenantId: null,
      ...over,
    };
  }

  it('creates with created=true and the integration response shape', async () => {
    const { created, body: res } = await upsertIntegrationTicket(agent, body());
    expect(created).toBe(true);
    expect(res.created).toBe(true);
    expect(res.ticketKey).toMatch(/-\d{6}$/);
    expect(res.status).toBe('triage');
    expect(res.assignee).toBeNull();
    expect(res.ignored.sort()).toEqual(['status', 'tenantId']);
    expect(res).not.toHaveProperty('ticket_number');
  });

  it('upserts the second time with created=false and the same identity', async () => {
    const payload = body();
    const first = await upsertIntegrationTicket(agent, payload);
    const second = await upsertIntegrationTicket(agent, { ...payload, title: 'Patch CVE-2026-1234 (rev 2)' });
    expect(second.created).toBe(false);
    expect(second.body.ticketId).toBe(first.body.ticketId);
    expect(second.body.ticketKey).toBe(first.body.ticketKey);
  });

  it('derives P2 from severity high', async () => {
    const { body: res } = await upsertIntegrationTicket(agent, body({ severity: 'high' }));
    const row = await withSystemContext(async (sql) =>
      (await sql.query('SELECT priority FROM tickets WHERE id=$1', [res.ticketId])).rows[0],
    );
    expect(row.priority).toBe('P2');
  });

  it('round-trips metadata semantically', async () => {
    const metadata = { carbonFindingId: 'f-1', nested: { kev: true, score: 9.8 }, list: [1, 2, 3] };
    const { body: res } = await upsertIntegrationTicket(agent, body({ metadata }));
    const row = await withSystemContext(async (sql) =>
      (await sql.query('SELECT custom_fields FROM tickets WHERE id=$1', [res.ticketId])).rows[0],
    );
    expect(row.custom_fields).toEqual(metadata);
  });

  it('rejects an organization outside the key principal scope with 403 (tenant boundary)', async () => {
    const keyPrincipal = buildKeyPrincipal({
      id: '00000000-0000-4000-8000-00000000a001', organization_id: orgId, key_id: 'k1', key_hash: 'x', name: 'test key',
      scopes: ['ticket.create', 'ticket.read.organization'], expires_at: null, revoked_at: null,
    });
    await expect(
      upsertIntegrationTicket(keyPrincipal, body({ organizationId: foreignOrgId })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets that same key principal file against its own org (the 403 is scope, not auth)', async () => {
    const keyPrincipal = buildKeyPrincipal({
      id: '00000000-0000-4000-8000-00000000a001', organization_id: orgId, key_id: 'k1', key_hash: 'x', name: 'test key',
      scopes: ['ticket.create', 'ticket.read.organization'], expires_at: null, revoked_at: null,
    });
    const { created } = await upsertIntegrationTicket(keyPrincipal, body());
    expect(created).toBe(true);
  });

  it('surfaces a sensitive metadata key as 422, not 500 (Review Focus 5)', async () => {
    await expect(
      upsertIntegrationTicket(agent, body({ metadata: { personal_email: 'leak@personal.example' } })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('resolves two concurrent first-syncs of one externalRef to a single ticket (Review Focus 4)', async () => {
    const payload = body();
    const [a, b] = await Promise.all([
      upsertIntegrationTicket(agent, payload),
      upsertIntegrationTicket(agent, payload),
    ]);
    expect(a.body.ticketId).toBe(b.body.ticketId);
    const count = await withSystemContext(async (sql) =>
      (await sql.query('SELECT count(*)::int AS n FROM tickets WHERE organization_id=$1 AND external_ref=$2',
        [orgId, payload.externalRef])).rows[0].n,
    );
    expect(count).toBe(1);
  });
});

describeDb('review fixes — upsert fidelity and the org boundary', () => {
  let agent: Principal;
  let customer: Principal;
  let orgId: string;
  const foreignOrgId = '00000000-0000-4000-8000-00000000dead';

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    customer = await principalByEmail('user@demo.example.com');
    orgId = await withSystemContext(
      async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  function body(over: Record<string, unknown> = {}) {
    return {
      externalRef: `fix-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      organizationId: orgId,
      source: 'poam',
      title: 'Patch CVE-2026-9999',
      ...over,
    };
  }

  it('keeps priority and severity consistent when a re-sync omits severity (Important 1)', async () => {
    const payload = body({ severity: 'critical' });
    const first = await upsertIntegrationTicket(agent, payload);

    const before = await withSystemContext(async (sql) =>
      (await sql.query('SELECT severity, impact, urgency, priority FROM tickets WHERE id=$1', [first.body.ticketId])).rows[0],
    );
    expect(before).toMatchObject({ severity: 'critical', impact: 1, urgency: 1, priority: 'P1' });

    // A partial re-sync that says nothing about severity — the documented presence rule
    // invites exactly this (an owner-only or dueDate-only update).
    await upsertIntegrationTicket(agent, {
      externalRef: payload.externalRef,
      organizationId: orgId,
      source: 'poam',
      title: 'Patch CVE-2026-9999',
      owner: 'Platform Team',
    });

    const after = await withSystemContext(async (sql) =>
      (await sql.query('SELECT severity, impact, urgency, priority FROM tickets WHERE id=$1', [first.body.ticketId])).rows[0],
    );
    expect(after).toMatchObject({ severity: 'critical', impact: 1, urgency: 1, priority: 'P1' });
  });

  it('refreshes external_source when a re-sync changes source (Important 3)', async () => {
    const payload = body({ source: 'poam' });
    const first = await upsertIntegrationTicket(agent, payload);
    await upsertIntegrationTicket(agent, { ...payload, source: 'conmon-poam' });

    const row = await withSystemContext(async (sql) =>
      (await sql.query('SELECT external_source FROM tickets WHERE id=$1', [first.body.ticketId])).rows[0],
    );
    expect(row.external_source).toBe('conmon-poam');
  });

  it('refuses a customer-plane principal naming another organization with 403 (Important 4)', async () => {
    await expect(
      upsertIntegrationTicket(customer, body({ organizationId: foreignOrgId })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('does not silently relocate the ticket into the caller org when another is named (Important 4)', async () => {
    const payload = body({ organizationId: foreignOrgId });
    await expect(upsertIntegrationTicket(customer, payload)).rejects.toMatchObject({ status: 403 });
    const count = await withSystemContext(async (sql) =>
      (await sql.query('SELECT count(*)::int AS n FROM tickets WHERE external_ref=$1', [payload.externalRef])).rows[0].n,
    );
    expect(count).toBe(0);
  });

  it('still lets a customer-plane principal file against its own organization', async () => {
    const { created } = await upsertIntegrationTicket(customer, body({ organizationId: orgId }));
    expect(created).toBe(true);
  });
});

describeDb('SLA clock suppression for backlog items', () => {
  let agent: Principal;
  let orgId: string;

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(
      async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  function body(source: string) {
    return {
      externalRef: `sla-${source}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      organizationId: orgId,
      source,
      title: `Work item from ${source}`,
    };
  }

  async function slaCount(ticketId: string) {
    return withSystemContext(async (sql) =>
      (await sql.query('SELECT count(*)::int AS n FROM sla_instances WHERE ticket_id=$1', [ticketId])).rows[0].n,
    );
  }

  it('writes no sla_instances rows for a backlog item', async () => {
    const { body: res } = await upsertIntegrationTicket(agent, body('backlog'));
    expect(await slaCount(res.ticketId)).toBe(0);
  });

  it('leaves a backlog ticket with no due stamps but still in triage', async () => {
    const { body: res } = await upsertIntegrationTicket(agent, body('backlog'));
    const row = await withSystemContext(async (sql) =>
      (await sql.query('SELECT status, response_due_at, resolution_due_at FROM tickets WHERE id=$1', [res.ticketId])).rows[0],
    );
    expect(row.status).toBe('triage');
    expect(row.response_due_at).toBeNull();
    expect(row.resolution_due_at).toBeNull();
  });

  it('still starts both clocks for a remediation item (no regression)', async () => {
    const { body: res } = await upsertIntegrationTicket(agent, body('poam'));
    expect(await slaCount(res.ticketId)).toBe(2);
  });
});

describeDb('phase D — backlog work items', () => {
  let agent: Principal;
  let orgId: string;

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(
      async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  const ref = (suffix: string) => `carbon-conmon:backlog:${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function item(externalRef: string, over: Record<string, unknown> = {}) {
    return { externalRef, organizationId: orgId, source: 'backlog', title: `Item ${externalRef}`, ...over };
  }

  async function row(ticketId: string) {
    return withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT status, priority, parent_ticket_id, parent_external_ref, external_priority,
                estimate_days, work_phase, workstream, acceptance_criteria, blocked_reason
           FROM tickets WHERE id=$1`, [ticketId])).rows[0],
    );
  }

  it('persists every backlog column', async () => {
    const { body: res } = await upsertIntegrationTicket(agent, item(ref('WS-1.1'), {
      estimateDays: 3.5, phase: 2, workstream: 'WS-1',
      acceptanceCriteria: 'The reconciler converges after a dropped webhook.',
      priority: 'P0',
    }));
    const r = await row(res.ticketId);
    expect(Number(r.estimate_days)).toBe(3.5);
    expect(r.work_phase).toBe('2');
    expect(r.workstream).toBe('WS-1');
    expect(r.acceptance_criteria).toMatch(/reconciler converges/);
    expect(r.external_priority).toBe('P0');
  });

  it('keeps the caller priority out of Anchor derived priority', async () => {
    const { body: res } = await upsertIntegrationTicket(agent, item(ref('WS-1.2'), { priority: 'P0' }));
    const r = await row(res.ticketId);
    expect(r.external_priority).toBe('P0');
    expect(r.priority).toBe('P3'); // derived from the 3/3 default, never from P0
  });

  it('creates a blocked item as blocked, with its reason', async () => {
    const { body: res } = await upsertIntegrationTicket(agent, item(ref('WS-2.1'), {
      blockedReason: 'Waiting on the Anchor contract',
    }));
    expect(res.status).toBe('blocked');
    const r = await row(res.ticketId);
    expect(r.status).toBe('blocked');
    expect(r.blocked_reason).toBe('Waiting on the Anchor contract');
  });

  it('links a story to an epic that already exists', async () => {
    const epicRef = ref('WS-3');
    const epic = await upsertIntegrationTicket(agent, item(epicRef));
    const story = await upsertIntegrationTicket(agent, item(ref('WS-3.1'), { parentExternalRef: epicRef }));
    expect((await row(story.body.ticketId)).parent_ticket_id).toBe(epic.body.ticketId);
  });

  it('defers the link when the story arrives before its epic, then resolves it', async () => {
    const epicRef = ref('WS-4');
    const story = await upsertIntegrationTicket(agent, item(ref('WS-4.1'), { parentExternalRef: epicRef }));
    // The epic does not exist yet: accepted, not rejected, and recorded for later.
    const before = await row(story.body.ticketId);
    expect(before.parent_ticket_id).toBeNull();
    expect(before.parent_external_ref).toBe(epicRef);

    const epic = await upsertIntegrationTicket(agent, item(epicRef));
    expect((await row(story.body.ticketId)).parent_ticket_id).toBe(epic.body.ticketId);
  });

  it('still starts no SLA clock for a backlog item carrying phase-D fields', async () => {
    const { body: res } = await upsertIntegrationTicket(agent, item(ref('WS-5.1'), { estimateDays: 2 }));
    const n = await withSystemContext(async (sql) =>
      (await sql.query('SELECT count(*)::int AS n FROM sla_instances WHERE ticket_id=$1', [res.ticketId])).rows[0].n,
    );
    expect(n).toBe(0);
  });
});
