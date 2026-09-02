import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import {
  createChange, submitForCab, castVote, cancelChange, recordPir,
  addComment, listComments, scheduleChange, transitionChange, getChange,
} from '../../src/modules/changes.js';
import { putBoard, createTemplate, deleteTemplate } from '../../src/modules/cab.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('change management + CAB voting (integration)', () => {
  // Segregation of duties (migration 0061): the CAB administrator does NOT hold
  // change.create, and the raisers do not hold cab.manage.
  let manager: Principal; // board chair: cab.manage + change.vote/implement, NO change.create
  let analyst: Principal; // board member + raiser: change.create + change.vote
  let agent: Principal;   // raiser: change.create + change.implement, NOT a voter
  let acmeId: string;

  /** Reset the standing board; returns to the two-member default when called with no args. */
  async function setBoard(members = [manager.id, analyst.id], quorum = 2) {
    await putBoard(manager, {
      organizationId: acmeId,
      name: 'Change Advisory Board',
      chairId: manager.id,
      quorum,
      threshold: 'majority',
      members: members.map((id) => ({ userId: id, role: id === manager.id ? 'chair' as const : 'member' as const })),
    });
  }

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    analyst = await principalByEmail('analyst@nexus.example.com');
    agent = await principalByEmail('agent@nexus.example.com');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id);
    expect(manager.permissions).toContain('cab.manage');
    expect(manager.permissions).not.toContain('change.create');
    await setBoard();
  });

  // ---- Pre-approval is not self-declarable (final review, CRITICAL 1) ----

  it('refuses a change.create holder declaring their own change standard', async () => {
    // submit-cab on a standard change returns `approved` with zero votes, so being able to
    // pick the type is being able to approve your own production change.
    await expect(
      createChange(agent, { title: 'Self-classified', changeType: 'standard', organizationId: acmeId }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('pre-approves a standard change only from a CAB-authored standard template', async () => {
    const tpl = await createTemplate(manager, {
      organizationId: acmeId, name: 'Rotate TLS cert', changeType: 'standard', risk: 'low',
    });
    try {
      const c = await createChange(agent, { title: 'Rotate TLS cert', templateId: tpl.id, organizationId: acmeId });
      expect(c.change_type).toBe('standard');
      expect(c.standard_template_id).toBe(tpl.id);
      expect(await submitForCab(agent, c.id, {})).toMatchObject({ status: 'approved', cab: false });

      // A template that is NOT itself pre-approved grants nothing.
      const normalTpl = await createTemplate(manager, {
        organizationId: acmeId, name: 'Connector upgrade', changeType: 'normal',
      });
      try {
        await expect(
          createChange(agent, { title: 'Borrowed pre-approval', changeType: 'standard', templateId: normalTpl.id, organizationId: acmeId }),
        ).rejects.toMatchObject({ status: 403 });
      } finally {
        await deleteTemplate(manager, normalTpl.id);
      }
    } finally {
      await deleteTemplate(manager, tpl.id);
    }
  });

  it('refuses to pre-approve a standard change whose template is gone', async () => {
    const tpl = await createTemplate(manager, {
      organizationId: acmeId, name: 'Retired pre-approval', changeType: 'standard',
    });
    const c = await createChange(agent, { title: 'Orphaned standard change', templateId: tpl.id, organizationId: acmeId });
    // ON DELETE SET NULL: retiring the template must not block the delete, and the draft
    // that loses its provenance must not be waved through as pre-approved.
    await deleteTemplate(manager, tpl.id);
    await expect(submitForCab(agent, c.id, {})).rejects.toMatchObject({ status: 403 });
  });

  it('derives risk from impact x likelihood on create', async () => {
    const c = await createChange(agent, { title: 'Risk-derived change', impact: 'high', likelihood: 'high', organizationId: acmeId });
    expect(c.risk).toBe('high');
  });

  it('normal change runs a quorum vote, schedules, and needs a PIR to close', async () => {
    const c = await createChange(agent, { title: 'Upgrade mail connector', changeType: 'normal', organizationId: acmeId });
    const sub = await submitForCab(agent, c.id, {});
    expect(sub).toMatchObject({ status: 'cab_review', cab: true, voters: 2, quorum: 2, quorum_requested: 2, quorum_clamped: false, threshold: 'majority' });
    expect(sub.vote_deadline).toBeTruthy();

    const d1 = await castVote(manager, c.id, 'approve');
    expect(d1.status).toBe('cab_review'); // quorum not yet met
    const d2 = await castVote(analyst, c.id, 'approve');
    expect(d2.status).toBe('approved');

    expect((await scheduleChange(manager, c.id, '2026-08-01T02:00:00.000Z', '2026-08-01T04:00:00.000Z')).status).toBe('scheduled');
    await transitionChange(manager, c.id, 'implementing');
    await transitionChange(manager, c.id, 'review');
    await expect(transitionChange(manager, c.id, 'closed')).rejects.toMatchObject({ status: 409 });
    expect((await recordPir(manager, c.id, 'successful', 'no incidents')).status).toBe('closed');

    const full = await getChange(manager, c.id);
    expect(full.votes.length).toBe(2);
    expect(full.cab_tally).toMatchObject({ approve: 2, cast: 2, pending: 0 });
    expect(full.pir_outcome).toBe('successful');
  });

  it('a CAB rejection rejects the change once passing is impossible', async () => {
    const c = await createChange(agent, { title: 'Risky firewall change', changeType: 'emergency', organizationId: acmeId });
    await submitForCab(agent, c.id, {});
    expect((await castVote(analyst, c.id, 'reject', 'insufficient backout plan')).status).toBe('rejected');
  });

  // ---- Segregation of duties (fix round 1, IMPORTANT 6) ----

  it('recuses the raiser from their own change and says so in the snapshot', async () => {
    const c = await createChange(analyst, { title: 'Raised by a board member', changeType: 'normal', organizationId: acmeId });
    const sub = await submitForCab(analyst, c.id, {});
    // analyst is on the board but raised it: roster drops to manager, quorum clamps 2 -> 1
    // and the clamp is reported rather than silently weakening the board's rule.
    expect(sub).toMatchObject({ voters: 1, quorum: 1, quorum_requested: 2, quorum_clamped: true });
    const full = await getChange(manager, c.id);
    expect(full.votes.map((v: any) => v.voter_id)).toEqual([manager.id]);
    // The clamp is PERSISTED, not just returned to the submitter: a voter opening this
    // change later must still be able to see that it votes at a weakened quorum.
    expect(full.cab_quorum).toBe(1);
    expect(full.cab_quorum_requested).toBe(2);
    // …and the raiser cannot vote even though they hold change.vote.
    await expect(castVote(analyst, c.id, 'approve')).rejects.toMatchObject({ status: 403 });
    expect((await castVote(manager, c.id, 'approve')).status).toBe('approved');
  });

  it('refuses a submit where the raiser would be the only voter', async () => {
    await setBoard([analyst.id], 1);
    try {
      const c = await createChange(analyst, { title: 'Self-approval attempt', changeType: 'normal', organizationId: acmeId });
      // Nor may the raiser hand themselves a ballot as an "ad-hoc reviewer".
      await expect(submitForCab(analyst, c.id, { extraVoterIds: [analyst.id] })).rejects.toMatchObject({ status: 403 });
      await expect(submitForCab(analyst, c.id, {})).rejects.toMatchObject({ status: 400 });
    } finally {
      await setBoard();
    }
  });

  // ---- The raiser does not pick their own approvers (final review, CRITICAL 2) ----

  it('refuses ad-hoc reviewers and a named board chosen by the raiser', async () => {
    const c = await createChange(agent, { title: 'Packed board attempt', changeType: 'normal', organizationId: acmeId });
    await expect(submitForCab(agent, c.id, { extraVoterIds: [analyst.id] })).rejects.toMatchObject({ status: 403 });
    const boardId = await withSystemContext(async (sql) =>
      (await sql.query('SELECT id FROM cab_boards WHERE organization_id=$1 AND is_default', [acmeId])).rows[0].id);
    await expect(submitForCab(agent, c.id, { boardId })).rejects.toMatchObject({ status: 403 });
    // The plain submit — standing board, standing quorum — still works.
    expect((await submitForCab(agent, c.id, {})).status).toBe('cab_review');
  });

  it('refuses a submit to a board that has never been configured', async () => {
    // 0052 seeds every org a default board with quorum 1 and NO members, which would
    // otherwise vote at a roster of whoever the submitter attached.
    await putBoard(manager, { organizationId: acmeId, chairId: null, quorum: 1, threshold: 'majority', members: [] });
    try {
      const c = await createChange(agent, { title: 'Memberless board', changeType: 'normal', organizationId: acmeId });
      // The reason has to name the unconfigured board — "the raiser cannot vote" would
      // send an admin looking for the wrong problem.
      await expect(submitForCab(agent, c.id, {})).rejects.toMatchObject({
        status: 400, detail: expect.stringContaining('no members'),
      });
      // …and the chair cannot paper over it with ad-hoc reviewers either.
      await expect(submitForCab(manager, c.id, { extraVoterIds: [analyst.id] })).rejects.toMatchObject({
        status: 400, detail: expect.stringContaining('no members'),
      });
    } finally {
      await setBoard();
    }
  });

  it('does not let ad-hoc ballots make the board quorate', async () => {
    await setBoard([analyst.id], 1);
    try {
      const c = await createChange(agent, { title: 'Ad-hoc quorum attempt', changeType: 'normal', organizationId: acmeId });
      // The CHAIR attaches the ad-hoc reviewer — the raiser may not.
      const sub = await submitForCab(manager, c.id, { extraVoterIds: [manager.id] });
      expect(sub).toMatchObject({ voters: 2, quorum: 1 });
      // The ad-hoc ballot counts toward the threshold but not toward quorum…
      expect((await castVote(manager, c.id, 'approve')).status).toBe('cab_review');
      // …the standing board member is what makes it quorate.
      expect((await castVote(analyst, c.id, 'approve')).status).toBe('approved');
    } finally {
      await setBoard();
    }
  });

  it('ships no role that can both raise changes and configure the CAB', async () => {
    const overlap = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT r.key FROM roles r
          WHERE EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id=r.id AND p.permission_key='change.create')
            AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id=r.id AND p.permission_key='cab.manage')`,
      )).rows);
    expect(overlap).toEqual([]);
  });

  it('refuses a vote from a change.vote holder with no change_votes row', async () => {
    await setBoard([analyst.id], 1);
    try {
      const c = await createChange(agent, { title: 'Analyst-only board', changeType: 'normal', organizationId: acmeId });
      await submitForCab(agent, c.id, {});
      // manager holds change.vote and did not raise it — only the missing roster row refuses them.
      expect(manager.permissions).toContain('change.vote');
      await expect(castVote(manager, c.id, 'approve')).rejects.toMatchObject({ status: 403 });
    } finally {
      await setBoard();
    }
  });

  it('lets a member change their vote while the ballot is still open, then closes it', async () => {
    const c = await createChange(agent, { title: 'Reconsidered change', changeType: 'normal', organizationId: acmeId });
    await submitForCab(agent, c.id, {});
    expect((await castVote(manager, c.id, 'abstain')).status).toBe('cab_review');
    expect((await castVote(manager, c.id, 'approve')).status).toBe('cab_review');
    const after = await getChange(manager, c.id);
    expect(after.votes.length).toBe(2);
    expect(after.cab_tally).toMatchObject({ approve: 1, abstain: 0, pending: 1 });
    expect((await castVote(analyst, c.id, 'approve')).status).toBe('approved');
    await expect(castVote(manager, c.id, 'reject')).rejects.toMatchObject({ status: 409 });
  });

  // ---- Concurrent finalization (fix round 1, IMPORTANT 4) ----

  it('serializes concurrent voters so a finalized outcome cannot be overwritten', async () => {
    await setBoard([manager.id, analyst.id], 1); // quorum 1: either vote alone resolves it
    try {
      const c = await createChange(agent, { title: 'Concurrent ballots', changeType: 'normal', organizationId: acmeId });
      await submitForCab(agent, c.id, {});

      const results = await Promise.allSettled([
        castVote(manager, c.id, 'approve'),
        castVote(analyst, c.id, 'reject'),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      // Without FOR UPDATE both transactions read `cab_review`, both resolve, and the second
      // UPDATE clobbers the first — approve-then-reject (or the reverse) both "succeed".
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0].reason).toMatchObject({ status: 409 });

      const stored = await withSystemContext(async (sql) =>
        (await sql.query('SELECT status FROM changes WHERE id=$1', [c.id])).rows[0]);
      expect(stored.status).toBe(won[0].value.status);
      expect(['approved', 'rejected']).toContain(stored.status);
    } finally {
      await setBoard();
    }
  });

  it('adds ad-hoc reviewers alongside the standing board', async () => {
    const c = await createChange(agent, { title: 'App-owner review needed', changeType: 'normal', organizationId: acmeId });
    // Attached by the CAB administrator, not the raiser. agent raised it so agent is
    // recused even when named; manager is already on the board and is deduped.
    const sub = await submitForCab(manager, c.id, { extraVoterIds: [agent.id, manager.id] });
    expect(sub.voters).toBe(2);
    const full = await getChange(manager, c.id);
    expect(full.votes.map((v: any) => v.voter_id).sort()).toEqual([manager.id, analyst.id].sort());
  });

  // ---- Cancellation authority (fix round 1, cheap item) ----

  it('cancels a change, but only for its raiser or a change manager', async () => {
    const c = await createChange(agent, { title: 'Withdrawn change', changeType: 'normal', organizationId: acmeId });
    await submitForCab(agent, c.id, {});
    // analyst holds change.create but neither raised it nor manages changes.
    expect(analyst.permissions).toContain('change.create');
    expect(analyst.permissions).not.toContain('change.implement');
    await expect(cancelChange(analyst, c.id)).rejects.toMatchObject({ status: 403 });
    expect((await cancelChange(agent, c.id, 'superseded')).status).toBe('cancelled');
    await expect(castVote(manager, c.id, 'approve')).rejects.toMatchObject({ status: 409 });
  });

  it('records a deliberation thread', async () => {
    const c = await createChange(agent, { title: 'Discussed change', changeType: 'normal', organizationId: acmeId });
    await addComment(manager, c.id, 'Needs a rollback rehearsal.');
    const thread = await listComments(analyst, c.id);
    expect(thread.map((t: any) => t.body)).toEqual(['Needs a rollback rehearsal.']);
  });
});
