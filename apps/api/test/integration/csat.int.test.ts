import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createSurveyForTicket, respond, pending, metrics, respondByTicket, ticketSurveyState } from '../../src/modules/csat.js';
import { createTicket } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('CSAT (integration)', () => {
  let endUser: Principal;
  let acmeId: string;
  let ticketId: string;

  beforeAll(async () => {
    endUser = await principalByEmail('user@demo.example.com');
    acmeId = endUser.organizationId!;
    // A fresh ticket per run keeps the survey unanswered (csat_surveys is unique per ticket),
    // so this test is idempotent across repeated runs.
    const t = await createTicket(endUser, { subject: `CSAT survey target ${Date.now()}`, impact: 3, urgency: 3 });
    ticketId = t.id;
  });

  it('issues a survey, accepts a response, and writes back satisfaction_score', async () => {
    await createSurveyForTicket(acmeId, ticketId);
    const list = await pending(endUser);
    const survey = list.find((s: any) => s.ticket_id === ticketId);
    expect(survey).toBeTruthy();

    const res = await respond(endUser, survey.id, 5, 'Quick and helpful');
    expect(res.score).toBe(5);

    const score = await withSystemContext(async (sql) =>
      (await sql.query('SELECT satisfaction_score FROM tickets WHERE id=$1', [ticketId])).rows[0].satisfaction_score,
    );
    expect(score).toBe(5);

    const m = await metrics(endUser);
    expect(m.responded).toBeGreaterThanOrEqual(1);
  });

  it('rejects a second response to the same survey', async () => {
    const survey = await withSystemContext(async (sql) =>
      (await sql.query('SELECT id FROM csat_surveys WHERE ticket_id=$1', [ticketId])).rows[0],
    );
    await expect(respond(endUser, survey.id, 3)).rejects.toThrow(/already answered/i);
  });

  it('lets the requester rate a resolved ticket with NO pre-created survey (find-or-create)', async () => {
    const t = await createTicket(endUser, { subject: `CSAT by-ticket ${Date.now()}`, impact: 3, urgency: 3 });
    await withSystemContext(async (sql) => sql.query("UPDATE tickets SET status='resolved' WHERE id=$1", [t.id]));

    const before = await ticketSurveyState(endUser, t.id);
    expect(before.ratable).toBe(true);
    expect(before.rated).toBe(false);

    const res = await respondByTicket(endUser, t.id, 4);
    expect(res.score).toBe(4);

    const after = await ticketSurveyState(endUser, t.id);
    expect(after.rated).toBe(true);
    expect(after.score).toBe(4);

    await expect(respondByTicket(endUser, t.id, 2)).rejects.toThrow(/already answered/i);
  });

  it('refuses to rate a ticket that is not resolved yet', async () => {
    const t = await createTicket(endUser, { subject: `CSAT not-resolved ${Date.now()}`, impact: 3, urgency: 3 });
    const st = await ticketSurveyState(endUser, t.id);
    expect(st.ratable).toBe(false);
    await expect(respondByTicket(endUser, t.id, 5)).rejects.toThrow(/not resolved/i);
  });
});
