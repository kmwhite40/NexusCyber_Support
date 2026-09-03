import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listPendingApprovals, approveExecution, rejectExecution } from '../../src/modules/automation.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

// Insert a pending gated execution the way the live handler does, returning its id.
async function seedPending(orgId: string, ruleId: string, ticketId: string, action: any, idem: string) {
  return withSystemContext(async (sql) => {
    const plan = [{ action, gated: true, performed: false }];
    const exec = (
      await sql.query(
        `INSERT INTO automation_executions (organization_id, rule_id, rule_version, trigger_event, outcome, steps, idempotency_key, ticket_id)
         VALUES ($1,$2,1,'ticket.created','pending_approval',$3,$4,$5) RETURNING id`,
        [orgId, ruleId, JSON.stringify(plan), idem, ticketId],
      )
    ).rows[0];
    const appr = (
      await sql.query(`INSERT INTO approvals (organization_id, subject_type, subject_id, status) VALUES ($1,'automation',$2,'requested') RETURNING id`, [orgId, exec.id])
    ).rows[0];
    await sql.query('UPDATE automation_executions SET approval_id=$1 WHERE id=$2', [appr.id, exec.id]);
    return exec.id as string;
  });
}

describeDb('automation gated-action approvals (integration)', () => {
  let manager: Principal; // automation.publish
  let orgId: string;
  let ruleId: string;
  let ticketId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    const row = await withSystemContext(async (sql) => ({
      org: (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
      rule: (await sql.query('SELECT id FROM automation_rules LIMIT 1')).rows[0].id,
      ticket: (await sql.query("SELECT id FROM tickets WHERE ticket_number='DEMO-000002'")).rows[0].id,
    }));
    orgId = row.org; ruleId = row.rule; ticketId = row.ticket;
  });

  it('approving a pending execution performs the gated add_comment', async () => {
    const before = await withSystemContext(async (sql) =>
      (await sql.query("SELECT count(*)::int AS n FROM ticket_comments WHERE ticket_id=$1 AND visibility='customer'", [ticketId])).rows[0].n,
    );
    const execId = await seedPending(orgId, ruleId, ticketId, { type: 'add_comment', text: 'Auto reply on approval' }, `test-approve-${Date.now()}`);

    const pending = await listPendingApprovals(manager);
    expect(pending.find((e: any) => e.id === execId)).toBeTruthy();

    const res = await approveExecution(manager, execId);
    expect(res.outcome).toBe('executed');

    const after = await withSystemContext(async (sql) =>
      (await sql.query("SELECT count(*)::int AS n FROM ticket_comments WHERE ticket_id=$1 AND visibility='customer'", [ticketId])).rows[0].n,
    );
    expect(after).toBe(before + 1);
  });

  it('rejecting a pending execution discards it', async () => {
    const execId = await seedPending(orgId, ruleId, ticketId, { type: 'change_status', to: 'closed' }, `test-reject-${Date.now()}`);
    const res = await rejectExecution(manager, execId);
    expect(res.outcome).toBe('rejected');
    await expect(approveExecution(manager, execId)).rejects.toThrow(/not pending/i);
  });
});
