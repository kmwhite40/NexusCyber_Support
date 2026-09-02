import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import {
  createChange, submitForCab, castVote, cancelChange, recordPir,
  addComment, listComments, scheduleChange, transitionChange, getChange,
} from '../../src/modules/changes.js';
import { putBoard } from '../../src/modules/cab.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('change management + CAB voting (integration)', () => {
  let manager: Principal; // change.create + change.vote + change.implement + cab.manage
  let analyst: Principal; // change.vote (second board member)
  let agent: Principal;   // NOT on the board
  let acmeId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    analyst = await principalByEmail('analyst@nexus.example.com');
    agent = await principalByEmail('agent@nexus.example.com');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id);
    // A real standing board: two members, quorum 2, simple majority.
    await putBoard(manager, {
      organizationId: acmeId,
      name: 'Change Advisory Board',
      chairId: manager.id,
      quorum: 2,
      threshold: 'majority',
      members: [{ userId: manager.id, role: 'chair' }, { userId: analyst.id, role: 'member' }],
    });
  });

  it('standard changes are pre-approved without CAB', async () => {
    const c = await createChange(manager, { title: 'Rotate TLS cert', changeType: 'standard', organizationId: acmeId });
    const res = await submitForCab(manager, c.id, {});
    expect(res).toMatchObject({ status: 'approved', cab: false });
  });

  it('derives risk from impact x likelihood on create', async () => {
    const c = await createChange(manager, { title: 'Risk-derived change', impact: 'high', likelihood: 'high', organizationId: acmeId });
    expect(c.risk).toBe('high');
  });

  it('normal change runs a quorum vote, schedules, and needs a PIR to close', async () => {
    const c = await createChange(manager, { title: 'Upgrade mail connector', changeType: 'normal', organizationId: acmeId });
    const sub = await submitForCab(manager, c.id, {});
    expect(sub).toMatchObject({ status: 'cab_review', cab: true, voters: 2, quorum: 2, threshold: 'majority' });
    expect(sub.vote_deadline).toBeTruthy();

    // First board member approves -> quorum not yet met, still in review.
    const d1 = await castVote(manager, c.id, 'approve');
    expect(d1.status).toBe('cab_review');
    // Second approves -> quorum met and majority passes.
    const d2 = await castVote(analyst, c.id, 'approve');
    expect(d2.status).toBe('approved');

    const sched = await scheduleChange(manager, c.id, '2026-08-01T02:00:00.000Z', '2026-08-01T04:00:00.000Z');
    expect(sched.status).toBe('scheduled');

    await transitionChange(manager, c.id, 'implementing');
    await transitionChange(manager, c.id, 'review');
    // Closing without a post-implementation review is refused.
    await expect(transitionChange(manager, c.id, 'closed')).rejects.toMatchObject({ status: 409 });
    const pir = await recordPir(manager, c.id, 'successful', 'no incidents');
    expect(pir.status).toBe('closed');

    const full = await getChange(manager, c.id);
    expect(full.votes.length).toBe(2);
    expect(full.cab_tally).toMatchObject({ approve: 2, cast: 2, pending: 0 });
    expect(full.pir_outcome).toBe('successful');
  });

  it('a CAB rejection rejects the change once passing is impossible', async () => {
    const c = await createChange(manager, { title: 'Risky firewall change', changeType: 'emergency', organizationId: acmeId });
    await submitForCab(manager, c.id, {});
    const res = await castVote(analyst, c.id, 'reject', 'insufficient backout plan');
    expect(res.status).toBe('rejected');
  });

  it('refuses a vote from someone with no change_votes row', async () => {
    const c = await createChange(manager, { title: 'Board-only change', changeType: 'normal', organizationId: acmeId });
    await submitForCab(manager, c.id, {});
    await expect(castVote(agent, c.id, 'approve')).rejects.toMatchObject({ status: 403 });
  });

  it('lets a member change their vote while the ballot is still open, then closes it', async () => {
    const c = await createChange(manager, { title: 'Reconsidered change', changeType: 'normal', organizationId: acmeId });
    await submitForCab(manager, c.id, {});
    expect((await castVote(manager, c.id, 'abstain')).status).toBe('cab_review');
    // Same voter, new vote: replaces the old one rather than adding a second ballot.
    expect((await castVote(manager, c.id, 'approve')).status).toBe('cab_review');
    const after = await getChange(manager, c.id);
    expect(after.votes.length).toBe(2);
    expect(after.cab_tally).toMatchObject({ approve: 1, abstain: 0, pending: 1 });
    // Second member approves -> resolved; the ballot is now closed to further votes.
    expect((await castVote(analyst, c.id, 'approve')).status).toBe('approved');
    await expect(castVote(manager, c.id, 'reject')).rejects.toMatchObject({ status: 409 });
  });

  it('adds ad-hoc reviewers alongside the standing board', async () => {
    const c = await createChange(manager, { title: 'App-owner review needed', changeType: 'normal', organizationId: acmeId });
    const sub = await submitForCab(manager, c.id, { extraVoterIds: [agent.id, manager.id] });
    expect(sub.voters).toBe(3); // board(2) + agent; manager is deduped
    const full = await getChange(manager, c.id);
    expect(full.votes.filter((v: any) => v.ad_hoc).map((v: any) => v.voter_id)).toEqual([agent.id]);
  });

  it('cancels a change that has not been implemented', async () => {
    const c = await createChange(manager, { title: 'Withdrawn change', changeType: 'normal', organizationId: acmeId });
    await submitForCab(manager, c.id, {});
    expect((await cancelChange(manager, c.id, 'superseded')).status).toBe('cancelled');
    await expect(castVote(manager, c.id, 'approve')).rejects.toMatchObject({ status: 409 });
  });

  it('records a deliberation thread', async () => {
    const c = await createChange(manager, { title: 'Discussed change', changeType: 'normal', organizationId: acmeId });
    await addComment(manager, c.id, 'Needs a rollback rehearsal.');
    const thread = await listComments(analyst, c.id);
    expect(thread.map((t: any) => t.body)).toEqual(['Needs a rollback rehearsal.']);
  });
});
