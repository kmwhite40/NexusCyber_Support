// On-call / paging engine (docs/nexus/04-sla-oncall.md §H). Resolves the current
// responder from a rotation, creates pages, handles acknowledgement, and escalates to
// the next responder on no-ack. Nexus-internal subsystem — authorized at the API layer.
import { withSystemContext } from '../db/pool.js';
import { authorize, can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

const ACK_DEADLINE_MIN: Record<string, number> = { Sev1: 5, Sev2: 15, Sev3: 30, Sev4: 60 };

// On-call tables have no RLS, but they JOIN users (which does), so reads/writes run
// via the owner (system) context. This subsystem is Nexus-internal; access is enforced
// at the API layer (nexus plane + oncall.* capability).
const q = (text: string, params: unknown[] = []) => withSystemContext((sql) => sql.query(text, params));

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
  phone: string | null;
  position: number;
  via: 'rotation' | 'override';
}

/** Re-sequence participant ids to contiguous positions 0..n-1, preserving order. Pure. */
export function repackPositions<T>(ordered: T[]): Array<{ item: T; position: number }> {
  return ordered.map((item, position) => ({ item, position }));
}

/** Resolve the current responder for a schedule's primary rotation. */
async function resolveCurrent(scheduleId: string, atIndexOffset = 0): Promise<Responder | null> {
  const rot = (
    await q(
      "SELECT * FROM oncall_rotations WHERE schedule_id=$1 AND role='primary' ORDER BY created_at LIMIT 1",
      [scheduleId],
    )
  ).rows[0];
  if (!rot) return null;

  const participants = (
    await q(
      `SELECT p.user_id, p.position, u.display_name AS name, u.phone
         FROM oncall_participants p JOIN users u ON u.id = p.user_id
        WHERE p.rotation_id=$1 ORDER BY p.position`,
      [rot.id],
    )
  ).rows;
  if (!participants.length) return null;

  // Active override wins.
  const now = new Date();
  const override = (
    await q(
      'SELECT o.user_id, u.display_name AS name, u.phone FROM oncall_overrides o JOIN users u ON u.id=o.user_id WHERE o.schedule_id=$1 AND o.starts_at<=$2 AND o.ends_at>$2 LIMIT 1',
      [scheduleId, now],
    )
  ).rows[0];
  if (override && atIndexOffset === 0) {
    return { userId: override.user_id, name: override.name, phone: override.phone ?? null, position: -1, via: 'override' };
  }

  const baseIdx = currentResponderIndex(participants.length, rot.length_days, new Date(rot.handoff_epoch).getTime(), now.getTime());
  const idx = (baseIdx + atIndexOffset) % participants.length;
  const p = participants[idx];
  return { userId: p.user_id, name: p.name, phone: p.phone ?? null, position: p.position, via: 'rotation' };
}

// Stable rotation anchor (a Monday 09:00) so handoffs line up week-to-week.
const HANDOFF_ANCHOR = '2026-01-05T09:00:00Z';

/** Candidate responders = Nexus employees. */
export async function listResponders(actor: Principal) {
  requireOnCallAccess(actor);
  return (await q("SELECT id, display_name AS name, email, phone FROM users WHERE plane='nexus' AND status='active' ORDER BY display_name")).rows;
}

/** Create a schedule with a primary rotation and an ordered roster. */
export async function createSchedule(
  actor: Principal,
  input: { team: string; tz?: string; coverage?: string; lengthDays?: number; participantIds: string[] },
) {
  authorize(actor, 'oncall.manage');
  if (!input.team?.trim()) throw Errors.badRequest('team name required');
  if (!input.participantIds?.length) throw Errors.badRequest('at least one responder required');

  const dup = (await q('SELECT 1 FROM oncall_schedules WHERE team=$1', [input.team])).rows[0];
  if (dup) throw Errors.conflict('a schedule with this team name already exists');

  const sched = (
    await q('INSERT INTO oncall_schedules (team, tz, coverage) VALUES ($1,$2,$3) RETURNING *', [
      input.team,
      input.tz ?? 'America/New_York',
      input.coverage ?? '24x7',
    ])
  ).rows[0];
  const rot = (
    await q("INSERT INTO oncall_rotations (schedule_id, role, length_days, handoff_epoch) VALUES ($1,'primary',$2,$3) RETURNING id", [
      sched.id,
      input.lengthDays ?? 7,
      HANDOFF_ANCHOR,
    ])
  ).rows[0];
  for (let i = 0; i < input.participantIds.length; i++) {
    await q('INSERT INTO oncall_participants (rotation_id, user_id, position) VALUES ($1,$2,$3)', [rot.id, input.participantIds[i], i]);
  }
  await audit(actor, { action: 'oncall.schedule_created', resourceType: 'oncall_schedule', resourceId: sched.id, detail: { team: input.team, responders: input.participantIds.length } });
  return { id: sched.id };
}

/** Replace a schedule's rotation length and roster. */
export async function updateRotation(actor: Principal, scheduleId: string, input: { lengthDays?: number; participantIds: string[] }) {
  authorize(actor, 'oncall.manage');
  const rot = (await q("SELECT id FROM oncall_rotations WHERE schedule_id=$1 AND role='primary' LIMIT 1", [scheduleId])).rows[0];
  if (!rot) throw Errors.notFound('rotation not found');
  if (input.lengthDays) await q('UPDATE oncall_rotations SET length_days=$1 WHERE id=$2', [input.lengthDays, rot.id]);
  if (input.participantIds) {
    await q('DELETE FROM oncall_participants WHERE rotation_id=$1', [rot.id]);
    for (let i = 0; i < input.participantIds.length; i++) {
      await q('INSERT INTO oncall_participants (rotation_id, user_id, position) VALUES ($1,$2,$3)', [rot.id, input.participantIds[i], i]);
    }
  }
  await audit(actor, { action: 'oncall.rotation_updated', resourceType: 'oncall_schedule', resourceId: scheduleId, detail: { responders: input.participantIds?.length } });
  return { ok: true };
}

/** Add a coverage override (PTO / swap). */
export async function createOverride(actor: Principal, input: { scheduleId: string; userId: string; startsAt: string; endsAt: string; reason?: string }) {
  authorize(actor, 'oncall.manage');
  await q(
    'INSERT INTO oncall_overrides (schedule_id, user_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4,$5)',
    [input.scheduleId, input.userId, input.startsAt, input.endsAt, input.reason ?? null],
  );
  await audit(actor, { action: 'oncall.override_created', resourceType: 'oncall_schedule', resourceId: input.scheduleId, detail: { userId: input.userId } });
  return { ok: true };
}

export async function listSchedules(actor: Principal) {
  requireOnCallAccess(actor);
  const schedules = (await q('SELECT * FROM oncall_schedules ORDER BY team')).rows;
  const out = [];
  for (const s of schedules) {
    const current = await resolveCurrent(s.id);
    const rot = (await q("SELECT * FROM oncall_rotations WHERE schedule_id=$1 AND role='primary' LIMIT 1", [s.id])).rows[0];
    const participants = rot
      ? (await q('SELECT p.user_id, p.position, u.display_name AS name, u.phone FROM oncall_participants p JOIN users u ON u.id=p.user_id WHERE p.rotation_id=$1 ORDER BY p.position', [rot.id])).rows
      : [];
    out.push({ id: s.id, team: s.team, tz: s.tz, coverage: s.coverage, current, rotationLengthDays: rot?.length_days ?? null, participants });
  }
  return out;
}

export async function listPages(actor: Principal) {
  requireOnCallAccess(actor);
  const { rows } = await q(
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
    scheduleId = (await q('SELECT id FROM oncall_schedules ORDER BY team LIMIT 1')).rows[0]?.id;
  }
  if (!scheduleId) throw Errors.badRequest('no on-call schedule configured');

  const responder = await resolveCurrent(scheduleId);
  const deadline = new Date(Date.now() + (ACK_DEADLINE_MIN[severity] ?? 15) * 60_000);
  const page = (
    await q(
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
  const page = (await q('SELECT * FROM oncall_pages WHERE id=$1', [pageId])).rows[0];
  if (!page) throw Errors.notFound('page not found');
  if (page.state === 'acknowledged' || page.state === 'resolved') throw Errors.conflict('page already handled');
  await q('INSERT INTO oncall_acknowledgements (page_id, user_id, via) VALUES ($1,$2,$3)', [pageId, actor.id, 'portal']);
  await q("UPDATE oncall_pages SET state='acknowledged', responder_id=$1 WHERE id=$2", [actor.id, pageId]);
  await audit(actor, { action: 'oncall.acknowledged', organizationId: page.organization_id, resourceType: 'oncall_page', resourceId: pageId });
  publish('oncall.acknowledged', page.organization_id, { page_id: pageId, responder: actor.id, via: 'portal' });
  return { state: 'acknowledged' };
}

export async function escalatePage(actor: Principal, pageId: string) {
  authorize(actor, 'oncall.page');
  const page = (await q('SELECT * FROM oncall_pages WHERE id=$1', [pageId])).rows[0];
  if (!page) throw Errors.notFound('page not found');
  const next = await resolveCurrent(page.schedule_id, 1); // next responder in rotation
  await q("UPDATE oncall_pages SET state='escalated', responder_id=$1 WHERE id=$2", [next?.userId ?? null, pageId]);
  await audit(actor, { action: 'oncall.escalated', organizationId: page.organization_id, resourceType: 'oncall_page', resourceId: pageId, detail: { to: next?.name } });
  publish('oncall.escalated', page.organization_id, { page_id: pageId, to_responder: next?.userId });
  return { state: 'escalated', responder: next?.name };
}

/** Delete a schedule (and its rotations/participants/overrides + closed pages). Blocked
 *  while any page is still OPEN so an active incident is never silently dropped. */
export async function deleteSchedule(actor: Principal, scheduleId: string) {
  authorize(actor, 'oncall.manage');
  const sched = (await q('SELECT id, team FROM oncall_schedules WHERE id=$1', [scheduleId])).rows[0];
  if (!sched) throw Errors.notFound('schedule not found');
  const open = (
    await q("SELECT count(*)::int AS n FROM oncall_pages WHERE schedule_id=$1 AND state IN ('created','notified','escalated')", [scheduleId])
  ).rows[0].n;
  if (open > 0) throw Errors.conflict(`cannot delete: ${open} open page(s) on this schedule — resolve them first`);
  await q('DELETE FROM oncall_schedules WHERE id=$1', [scheduleId]); // cascades rotations/participants/overrides/closed pages
  await audit(actor, { action: 'oncall.schedule_deleted', resourceType: 'oncall_schedule', resourceId: scheduleId, detail: { team: sched.team } });
  return { ok: true };
}

/** Remove a responder from a schedule's primary rotation and re-pack the order. A rotation
 *  must keep at least one responder (delete the schedule instead to retire it). */
export async function removeParticipant(actor: Principal, scheduleId: string, userId: string) {
  authorize(actor, 'oncall.manage');
  const rot = (await q("SELECT id FROM oncall_rotations WHERE schedule_id=$1 AND role='primary' LIMIT 1", [scheduleId])).rows[0];
  if (!rot) throw Errors.notFound('rotation not found');
  const current = (await q('SELECT user_id FROM oncall_participants WHERE rotation_id=$1 ORDER BY position', [rot.id])).rows;
  if (!current.some((r) => r.user_id === userId)) throw Errors.notFound('responder is not in this rotation');
  if (current.length <= 1) throw Errors.conflict('cannot remove the last responder — delete the schedule instead');

  await q('DELETE FROM oncall_participants WHERE rotation_id=$1 AND user_id=$2', [rot.id, userId]);
  // Re-pack remaining responders to contiguous positions (keeps rotation math + the
  // UNIQUE(rotation_id, position) constraint clean). Use a temp offset to avoid collisions.
  const remaining = current.filter((r) => r.user_id !== userId).map((r) => r.user_id);
  await q('UPDATE oncall_participants SET position = position + 1000 WHERE rotation_id=$1', [rot.id]);
  for (const { item, position } of repackPositions(remaining)) {
    await q('UPDATE oncall_participants SET position=$1 WHERE rotation_id=$2 AND user_id=$3', [position, rot.id, item]);
  }
  await audit(actor, { action: 'oncall.participant_removed', resourceType: 'oncall_schedule', resourceId: scheduleId, detail: { userId } });
  return { ok: true, remaining: remaining.length };
}

/** Set (or clear) a responder's cell number used for on-call paging. */
export async function setResponderPhone(actor: Principal, userId: string, phone: string | null) {
  authorize(actor, 'oncall.manage');
  const u = (await q("SELECT id FROM users WHERE id=$1 AND plane='nexus'", [userId])).rows[0];
  if (!u) throw Errors.notFound('responder not found');
  const normalized = phone && phone.trim() ? phone.trim() : null;
  await q('UPDATE users SET phone=$1, updated_at=now() WHERE id=$2', [normalized, userId]);
  await audit(actor, { action: 'oncall.responder_phone_set', resourceType: 'user', resourceId: userId, detail: { has_phone: !!normalized } });
  return { ok: true, phone: normalized };
}
