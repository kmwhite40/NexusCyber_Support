import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket, getTicket, addComment, assignTicket, escalate } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

// The ticket detail view showed "Agent (internal)" / "Participant" instead of a person, never said
// who assigned a ticket, and the customer view could not tell who wrote a reply. Names now come
// from a system-context lookup: a LEFT JOIN on users in org context returns NULL for every Nexus
// agent, because RLS hides their org-NULL rows from a customer org's context.
//
// The same change closes a leak: getTicket returned every ticket_event to the customer plane,
// including an escalation's internal reason and the 'commented' events for internal notes.
async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const displayName = (id: string) => withSystemContext(async (sql) =>
  (await sql.query('SELECT display_name FROM users WHERE id=$1', [id])).rows[0].display_name as string);

describeDb('ticket comment authors, event actors and assignment (integration)', () => {
  let agent: Principal;    // Tier2: comment, assign, escalate
  let manager: Principal;  // ServiceDeskManager: assign
  let customer: Principal; // Demo Corp end user, the requester
  let agentName: string;
  let managerName: string;
  let ticketId: string;
  const createdTicketIds: string[] = [];
  const REASON = 'requester keeps reopening; needs a senior pair of eyes';
  const INTERNAL_NOTE = 'internal: suspect the MDM profile, not the mailbox';

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
    manager = await principalByEmail('manager@nexus.example.com');
    customer = await principalByEmail('user@demo.example.com');
    agentName = await displayName(agent.id);
    managerName = await displayName(manager.id);

    const t = await createTicket(customer, { subject: `Author names ${Date.now()}`, impact: 3, urgency: 3 });
    ticketId = t.id;
    createdTicketIds.push(t.id);

    await addComment(agent, ticketId, 'Looking into this now.', 'customer');
    await addComment(agent, ticketId, INTERNAL_NOTE, 'internal');
    await escalate(agent, ticketId, 'Tier 2 — M365 Administrator', REASON);
    // A -> B: the manager hands it to the agent, then the agent hands it to the manager.
    await assignTicket(manager, ticketId, agent.id, null);
    await assignTicket(agent, ticketId, manager.id, null);
  });

  afterAll(async () => {
    await withSystemContext(async (sql) => {
      if (createdTicketIds.length) await sql.query('DELETE FROM tickets WHERE id = ANY($1)', [createdTicketIds]);
    });
  });

  it("names an agent's comment on a customer-org ticket, for the agent", async () => {
    const t: any = await getTicket(agent, ticketId);
    const reply = t.comments.find((c: any) => c.body === 'Looking into this now.');
    expect(reply.author).toEqual({ id: agent.id, name: agentName });
    expect(agentName).toBeTruthy();
    const note = t.comments.find((c: any) => c.body === INTERNAL_NOTE);
    expect(note.author?.name).toBe(agentName);
  });

  it("shows the customer the agent's name, but never the agent's email", async () => {
    const t: any = await getTicket(customer, ticketId);
    const reply = t.comments.find((c: any) => c.body === 'Looking into this now.');
    expect(reply.author).toEqual({ id: agent.id, name: agentName });
    expect(JSON.stringify(t)).not.toContain('agent@nexus.example.com');
    expect(JSON.stringify(t)).not.toContain('manager@nexus.example.com');
    // Requester/affected-user email resolution stays staff-only.
    expect(t.requester).toBeUndefined();
  });

  it('hides internal notes, their events, and the escalation reason from the customer', async () => {
    const t: any = await getTicket(customer, ticketId);
    const raw = JSON.stringify(t);
    expect(t.comments.map((c: any) => c.body)).not.toContain(INTERNAL_NOTE);
    expect(raw).not.toContain(INTERNAL_NOTE);
    expect(raw).not.toContain(REASON);
    expect(t.events.some((e: any) => e.event_type === 'commented' && e.detail?.visibility === 'internal')).toBe(false);
    const esc = t.events.find((e: any) => e.event_type === 'escalated');
    expect(esc).toBeTruthy();
    expect(esc.detail).toEqual({});
    // The customer-visible reply's event is still there, with its actor named.
    const commented = t.events.filter((e: any) => e.event_type === 'commented');
    expect(commented).toHaveLength(1);
    expect(commented[0].actor).toEqual({ id: agent.id, name: agentName });
  });

  it('still gives the agent the full event log, with the reason', async () => {
    const t: any = await getTicket(agent, ticketId);
    expect(t.events.find((e: any) => e.event_type === 'escalated').detail.reason).toBe(REASON);
    expect(t.events.filter((e: any) => e.event_type === 'commented')).toHaveLength(2);
  });

  it('reports the assignee and who assigned them after A -> B', async () => {
    for (const viewer of [agent, customer]) {
      const t: any = await getTicket(viewer, ticketId);
      expect(t.assignee).toEqual({ id: manager.id, name: managerName });
      expect(t.assigned_by).toMatchObject({ id: agent.id, name: agentName });
      expect(t.assigned_by.at).toBeTruthy();
    }
  });
});
