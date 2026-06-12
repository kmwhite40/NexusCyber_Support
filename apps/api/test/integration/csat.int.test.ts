import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createSurveyForTicket, respond, pending, metrics } from '../../src/modules/csat.js';
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
    endUser = await principalByEmail('user@acme.example.com');
    const row = await withSystemContext(async (sql) =>
      (await sql.query("SELECT t.id AS tid, t.organization_id AS oid FROM tickets t JOIN organizations o ON o.id=t.organization_id WHERE o.name='Acme' AND t.requester_id=(SELECT id FROM users WHERE email='user@acme.example.com') LIMIT 1")).rows[0],
    );
    ticketId = row.tid;
    acmeId = row.oid;
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
