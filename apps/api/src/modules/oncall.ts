// On-call / paging engine (docs/nexus/04-sla-oncall.md §H). Resolves the current
// responder from a rotation, creates pages, handles acknowledgement, and escalates to
// the next responder on no-ack. Nexus-internal subsystem — authorized at the API layer.
import { pool } from '../db/pool.js';
import { authorize, can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

const ACK_DEADLINE_MIN: Record<string, number> = { Sev1: 5, Sev2: 15, Sev3: 30, Sev4: 60 };

/**
 * Pure rotation math: which participant index is on call at `atMs`, given a rotation
 * that started at `handoffEpochMs` and rotates every `lengthDays`. Returns -1 if empty.
 */
export function currentResponderIndex(
  participantsCount: number,
  lengthDays: number,
  handoffEpochMs: number,
  atMs: number,
): number {
  if (participantsCount <= 0) return -1;
  const elapsedDays = Math.floor((atMs - handoffEpochMs) / 86_400_000);
  const periods = Math.floor(elapsedDays / Math.max(1, lengthDays));
  return ((periods % participantsCount) + participantsCount) % participantsCount;
}

function requireOnCallAccess(actor: Principal) {
  if (actor.plane !== 'nexus' || !(can(actor, 'oncall.acknowledge') || can(actor, 'oncall.page') || can(actor, 'oncall.manage'))) {
    throw Errors.forbidden('on-call access requires a Nexus on-call role');
  }
}

interface Responder {
  userId: string;
  name: string;
  position: number;
  via: 'rotation' | 'override';
}

/** Resolve the current responder for a schedule's primary rotation. */
async function resolveCurrent(scheduleId: string, atIndexOffset = 0): Promise<Responder | null> {
  const rot = (
    await pool.query(
      "SELECT * FROM oncall_rotations WHERE schedule_id=$1 AND role='primary' ORDER BY created_at LIMIT 1",
      [scheduleId],
    )
  ).rows[0];
  if (!rot) return null;

  const participants = (
    await pool.query(
      `SELECT p.user_id, p.position, u.display_name AS name
         FROM oncall_participants p JOIN users u ON u.id = p.user_id
        WHERE p.rotation_id=$1 ORDER BY p.position`,
      [rot.id],
    )
  ).rows;
  if (!participants.length) return null;

  // Active override wins.
  const now = new Date();
  const override = (
    await pool.query(
      'SELECT o.user_id, u.display_name AS name FROM oncall_overrides o JOIN users u ON u.id=o.user_id WHERE o.schedule_id=$1 AND o.starts_at<=$2 AND o.ends_at>$2 LIMIT 1',
      [scheduleId, now],
    )
  ).rows[0];
  if (override && atIndexOffset === 0) {
    return { userId: override.user_id, name: override.name, position: -1, via: 'override' };
  }

  const baseIdx = currentResponderIndex(participants.length, rot.length_days, new Date(rot.handoff_epoch).getTime(), now.getTime());
  const idx = (baseIdx + atIndexOffset) % participants.length;
  const p = participants[idx];
  return { userId: p.user_id, name: p.name, position: p.position, via: 'rotation' };
}

export async function listSchedules(actor: Principal) {
  requireOnCallAccess(actor);
  const schedules = (await pool.query('SELECT * FROM oncall_schedules ORDER BY team')).rows;
  const out = [];
  for (const s of schedules) {
    const current = await resolveCurrent(s.id);
    const rot = (await pool.query("SELECT * FROM oncall_rotations WHERE schedule_id=$1 AND role='primary' LIMIT 1", [s.id])).rows[0];
    const participants = rot
      ? (await pool.query('SELECT p.position, u.display_name AS name FROM oncall_participants p JOIN users u ON u.id=p.user_id WHERE p.rotation_id=$1 ORDER BY p.position', [rot.id])).rows
      : [];
    out.push({ id: s.id, team: s.team, tz: s.tz, coverage: s.coverage, current, rotationLengthDays: rot?.length_days ?? null, participants });
  }
  return out;
}

export async function listPages(actor: Principal) {
  requireOnCallAccess(actor);
  const { rows } = await pool.query(
    `SELECT pg.id, pg.severity, pg.state, pg.created_at, pg.ack_deadline_at, pg.ticket_id,
            u.display_name AS responder, o.name AS org,
            (SELECT acked_at FROM oncall_acknowledgements a WHERE a.page_id=pg.id ORDER BY acked_at LIMIT 1) AS acked_at
       FROM oncall_pages pg
       LEFT JOIN users u ON u.id = pg.responder_id
       LEFT JOIN organizations o ON o.id = pg.organization_id
      ORDER BY pg.created_at DESC LIMIT 50`,
  );
  return rows;
}

export async function createPage(actor: Principal, input: { scheduleId?: string; ticketId?: string; organizationId?: string; severity?: string }) {
  authorize(actor, 'oncall.page');
  const severity = input.severity ?? 'Sev2';
  let scheduleId = input.scheduleId;
  if (!scheduleId) {
    scheduleId = (await pool.query('SELECT id FROM oncall_schedules ORDER BY team LIMIT 1')).rows[0]?.id;
  }
  if (!scheduleId) throw Errors.badRequest('no on-call schedule configured');

  const responder = await resolveCurrent(scheduleId);
  const deadline = new Date(Date.now() + (ACK_DEADLINE_MIN[severity] ?? 15) * 60_000);
  const page = (
    await pool.query(
      `INSERT INTO oncall_pages (organization_id, ticket_id, schedule_id, severity, responder_id, state, ack_deadline_at)
       VALUES ($1,$2,$3,$4,$5,'notified',$6) RETURNING *`,
      [input.organizationId ?? null, input.ticketId ?? null, scheduleId, severity, responder?.userId ?? null, deadline],
    )
  ).rows[0];

  await audit(actor, { action: 'oncall.page_created', organizationId: input.organizationId ?? null, resourceType: 'oncall_page', resourceId: page.id, detail: { severity, responder: responder?.name } });
  publish('oncall.page_created', input.organizationId ?? null, { page_id: page.id, ticket_id: input.ticketId ?? null, schedule: scheduleId, severity });
  publish('oncall.acknowledgement_required', input.organizationId ?? null, { page_id: page.id, responder: responder?.userId, deadline: deadline.toISOString() });
  return { ...page, responder: responder?.name };
}

export async function acknowledge(actor: Principal, pageId: string) {
  authorize(actor, 'oncall.acknowledge');
  const page = (await pool.query('SELECT * FROM oncall_pages WHERE id=$1', [pageId])).rows[0];
  if (!page) throw Errors.notFound('page not found');
  if (page.state === 'acknowledged' || page.state === 'resolved') throw Errors.conflict('page already handled');
  await pool.query('INSERT INTO oncall_acknowledgements (page_id, user_id, via) VALUES ($1,$2,$3)', [pageId, actor.id, 'portal']);
  await pool.query("UPDATE oncall_pages SET state='acknowledged', responder_id=$1 WHERE id=$2", [actor.id, pageId]);
  await audit(actor, { action: 'oncall.acknowledged', organizationId: page.organization_id, resourceType: 'oncall_page', resourceId: pageId });
  publish('oncall.acknowledged', page.organization_id, { page_id: pageId, responder: actor.id, via: 'portal' });
  return { state: 'acknowledged' };
}

export async function escalatePage(actor: Principal, pageId: string) {
  authorize(actor, 'oncall.page');
  const page = (await pool.query('SELECT * FROM oncall_pages WHERE id=$1', [pageId])).rows[0];
  if (!page) throw Errors.notFound('page not found');
  const next = await resolveCurrent(page.schedule_id, 1); // next responder in rotation
  await pool.query("UPDATE oncall_pages SET state='escalated', responder_id=$1 WHERE id=$2", [next?.userId ?? null, pageId]);
  await audit(actor, { action: 'oncall.escalated', organizationId: page.organization_id, resourceType: 'oncall_page', resourceId: pageId, detail: { to: next?.name } });
  publish('oncall.escalated', page.organization_id, { page_id: pageId, to_responder: next?.userId });
  return { state: 'escalated', responder: next?.name };
}
