import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listWorkflows, createWorkflow, addTransition } from '../../src/modules/workflows.js';
import { createTicket, transition } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('configurable workflows (integration)', () => {
  let manager: Principal; // automation.author
  let agent: Principal;
  let acmeId: string;
  // Every row this suite creates, so it can remove them again. Without this the suite leaked a
  // workflow and a ticket per run — 155 workflows and 153 tickets had accumulated in dev — and
  // any future assertion about workflow or ticket counts would have been fighting that noise.
  const createdWorkflowIds: string[] = [];
  const createdTicketIds: string[] = [];

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    agent = await principalByEmail('agent@nexus.example.com');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id);
  });

  afterAll(async () => {
    await withSystemContext(async (sql) => {
      // Tickets first: workflow_transitions cascade from workflows, but a ticket referencing a
      // deleted workflow's ticket_type would simply be orphaned text, so clear both explicitly.
      if (createdTicketIds.length) {
        await sql.query('DELETE FROM tickets WHERE id = ANY($1)', [createdTicketIds]);
      }
      if (createdWorkflowIds.length) {
        await sql.query('DELETE FROM workflows WHERE id = ANY($1)', [createdWorkflowIds]);
      }
    });
  });

  it('seeded default incident workflow is listed and drives transitions', async () => {
    const list = await listWorkflows(manager);
    expect(list.find((w: any) => w.ticket_type === 'incident' && w.organization_id === null)).toBeTruthy();

    // A standard incident transition (allowed by the default map) succeeds.
    const t = await createTicket(agent, { subject: 'Workflow incident', organizationId: acmeId, impact: 3, urgency: 3 });
    createdTicketIds.push(t.id);
    await transition(agent, t.id, 'assigned'); // triage -> assigned is allowed
  });

  it('an org-specific workflow overrides the default and is enforced', async () => {
    // Unique per run so the test is idempotent (workflows are unique by org + ticket_type).
    const customType = `wf_test_${Date.now()}`;
    // Create a restrictive org workflow for a custom type that only allows triage->resolved.
    const wf = await createWorkflow(manager, { ticketType: customType, name: 'Restrictive', organizationId: acmeId });
    createdWorkflowIds.push(wf.id);
    await addTransition(manager, wf.id, 'triage', 'resolved');

    const t = await createTicket(agent, { type: customType, subject: 'Custom WF', organizationId: acmeId, impact: 3, urgency: 3 });
    createdTicketIds.push(t.id);
    // 'assigned' is NOT in the custom workflow -> rejected.
    await expect(transition(agent, t.id, 'assigned')).rejects.toThrow(/illegal transition/i);
    // 'resolved' IS allowed by the custom workflow.
    const res = await transition(agent, t.id, 'resolved');
    expect(res.status).toBe('resolved');
  });
});
