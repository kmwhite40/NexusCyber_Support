import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createSurveyForTicket, respond, pending, metrics } from '../../src/modules/csat.js';
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
});
