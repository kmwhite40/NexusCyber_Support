import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket, assignTicket, transition } from '../../src/modules/tickets.js';
import { editTicket, listAssignees } from '../../src/modules/ticket-admin.js';
import type { Principal } from '../../src/types.js';

// End-to-end against the seeded roles: who may edit and reassign, what an edit writes (columns,
// priority, live SLA deadlines, event, audit), and who a ticket may be handed to.
async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const q = <T = any>(text: string, params: unknown[] = []) =>
  withSystemContext(async (sql) => (await sql.query(text, params)).rows as T[]);

const status = (p: Promise<unknown>) => p.then(() => 200, (e: any) => e.status ?? e);

describeDb('ticket admin: edit + reassign (integration)', () => {
  let customer: Principal;
  let manager: Principal; // ServiceDeskManager — ticket.edit + ticket.assign
  let tier2: Principal; // ticket.assign, no ticket.edit
  let tier1: Principal; // neither
  let otherOrgId: string;
  let otherOrgGroupId: string;

  const file = async (over: Record<string, unknown> = {}) =>
    (await createTicket(customer, { subject: 'Printer jams on tray 2', description: 'Every third page', impact: 3, urgency: 3, ...over })).id as string;

  beforeAll(async () => {
    customer = await principalByEmail('user@demo.example.com');
    manager = await principalByEmail('manager@nexus.example.com');
    tier2 = await principalByEmail('agent@nexus.example.com');
    tier1 = await principalByEmail('desk1@nexus.example.com');
    otherOrgId = (await q("INSERT INTO organizations (name) VALUES ('Ticket Admin Other Org ' || gen_random_uuid()) RETURNING id"))[0].id;
    otherOrgGroupId = (await q("INSERT INTO assignment_groups (scope, organization_id, name) VALUES ('org',$1,'Other org desk') RETURNING id", [otherOrgId]))[0].id;
  });

  afterAll(async () => {
    if (otherOrgId) await q('DELETE FROM organizations WHERE id=$1', [otherOrgId]);
  });

  it('seed grants ticket.edit to ServiceDeskManager only', () => {
    expect(manager.permissions).toContain('ticket.edit');
    expect(tier2.permissions).not.toContain('ticket.edit');
    expect(tier1.permissions).not.toContain('ticket.edit');
  });

  it('lets a manager edit fields; priority is re-derived, live SLA deadlines move, event + audit written', async () => {
    const id = await file();
    const [before] = await q("SELECT due_at FROM sla_instances WHERE ticket_id=$1 AND metric='response'", [id]);

    const out = await editTicket(manager, id, { subject: 'Printer jams on every tray', category: 'printing', impact: 1, urgency: 1 }, { reason: 'User called back: whole floor down' });
    expect(out.subject).toBe('Printer jams on every tray');
    expect(out.category).toBe('printing');
    expect(out.priority).toBe('P1');

    const [after] = await q("SELECT due_at FROM sla_instances WHERE ticket_id=$1 AND metric='response'", [id]);
    expect(new Date(after.due_at).getTime()).toBeLessThan(new Date(before.due_at).getTime()); // P3 -> P1 tightens
    const [t] = await q('SELECT response_due_at FROM tickets WHERE id=$1', [id]);
    expect(new Date(t.response_due_at).getTime()).toBe(new Date(after.due_at).getTime());

    const [ev] = await q("SELECT detail FROM ticket_events WHERE ticket_id=$1 AND event_type='edited'", [id]);
    expect(ev.detail.reason).toBe('User called back: whole floor down');
    expect(ev.detail.changes.map((c: any) => c.field).sort()).toEqual(['category', 'impact', 'priority', 'subject', 'urgency']);
    const [au] = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action='ticket.edit' AND resource_id=$1", [id]);
    expect(au.n).toBe(1);
  });

  it('records a description change without copying the text into the trail', async () => {
    const id = await file();
    await editTicket(manager, id, { description: 'Secret-ish detail' });
    const [ev] = await q("SELECT detail FROM ticket_events WHERE ticket_id=$1 AND event_type='edited'", [id]);
    expect(ev.detail.changes).toEqual([{ field: 'description', changed: true }]);
  });

  it('refuses agents without ticket.edit, customers, no-op edits, bad values and closed tickets', async () => {
    const id = await file();
    expect(await status(editTicket(tier2, id, { subject: 'x' }))).toBe(403);
    expect(await status(editTicket(customer, id, { subject: 'x' }))).toBe(403);
    expect(await status(editTicket(manager, id, { subject: 'Printer jams on tray 2' }))).toBe(400);
    expect(await status(editTicket(manager, id, { impact: 9 }))).toBe(422);

    await q("UPDATE tickets SET status='closed', closed_at=now() WHERE id=$1", [id]);
    expect(await status(editTicket(manager, id, { subject: 'x' }))).toBe(409);
  });

  it('lists staff and groups a ticket can go to, never customer users or another org\'s groups', async () => {
    const id = await file();
    const { agents, groups } = await listAssignees(tier2, id);
    const ids = agents.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([manager.id, tier2.id, tier1.id]));
    expect(ids).not.toContain(customer.id);
    expect(groups.map((g) => g.id)).not.toContain(otherOrgGroupId);
    expect(groups.length).toBeGreaterThan(0);
    expect(await status(listAssignees(tier1, id))).toBe(403); // no ticket.assign
  });

  it('reassigns between agents and records who it came from', async () => {
    const id = await file();
    await assignTicket(tier2, id, tier2.id, null);
    await assignTicket(manager, id, tier1.id, null);

    const [t] = await q('SELECT assigned_agent_id FROM tickets WHERE id=$1', [id]);
    expect(t.assigned_agent_id).toBe(tier1.id);
    const evs = await q("SELECT detail FROM ticket_events WHERE ticket_id=$1 AND event_type='assigned' ORDER BY created_at", [id]);
    expect(evs.at(-1)!.detail).toMatchObject({ assignedAgentId: tier1.id, fromAgentId: tier2.id, reassigned: true });
  });

  it('refuses to assign to a customer user or to another org\'s group', async () => {
    const id = await file();
    expect(await status(assignTicket(manager, id, customer.id, null))).toBe(422);
    expect(await status(assignTicket(manager, id, null, otherOrgGroupId))).toBe(422);
    const [t] = await q('SELECT assigned_agent_id, assignment_group_id FROM tickets WHERE id=$1', [id]);
    expect(t).toEqual({ assigned_agent_id: null, assignment_group_id: null });
  });

  it('still lets an agent claim a ticket (assign to self)', async () => {
    const id = await file();
    await assignTicket(tier2, id, tier2.id, null);
    await transition(tier2, id, 'in_progress');
    const [t] = await q('SELECT assigned_agent_id, status FROM tickets WHERE id=$1', [id]);
    expect(t).toEqual({ assigned_agent_id: tier2.id, status: 'in_progress' });
  });
});
