// SLA engine (docs/nexus/04 §H, ADR-011). One engine serves all ticket types.
// This reference implements: target resolution by priority, due-date computation
// (business-hours-aware for 8x5 calendars), and state evaluation with idempotent
// warning/breach. A production engine adds holidays, maintenance windows, and the
// nightly reconciliation sweep.
import type { Sql } from '../db/pool.js';

export type SlaMetric = 'response' | 'resolution' | 'update' | 'remediation';

// Severity-based service levels (8x5 business minutes). `response` = "We acknowledge",
// `resolution` = "We aim to resolve". A business day = one 8-hour 8x5 workday (480 min),
// so e.g. "5 business days" = 5 * 480 = 2400 min. These apply to every organization.
const BUSINESS_DAY = 8 * 60; // 480 business minutes = one 8x5 workday
const DEFAULT_TARGETS_MINUTES: Record<string, Record<SlaMetric, number>> = {
  // priority -> metric -> minutes (business minutes)
  P1: { response: 60, resolution: 4 * 60, update: 60, remediation: 7 * 24 * 60 },
  P2: { response: 4 * 60, resolution: 1 * BUSINESS_DAY, update: 120, remediation: 30 * 24 * 60 },
  P3: { response: 1 * BUSINESS_DAY, resolution: 5 * BUSINESS_DAY, update: 240, remediation: 90 * 24 * 60 },
  P4: { response: 2 * BUSINESS_DAY, resolution: 10 * BUSINESS_DAY, update: 480, remediation: 90 * 24 * 60 },
};

interface CalendarLike {
  coverage: '8x5' | '24x7';
  tz: string;
  /** ISO 'YYYY-MM-DD' holiday dates excluded from 8x5 business time. */
  holidays?: string[];
}

const BUSINESS_START_HOUR = 9; // local 09:00–17:00 for 8x5
const BUSINESS_END_HOUR = 17;

/** The UTC calendar date of an instant as 'YYYY-MM-DD'. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add N business minutes from `start` honoring an 8x5 or 24x7 calendar (and holidays). */
export function addBusinessMinutes(start: Date, minutes: number, cal: CalendarLike): Date {
  if (cal.coverage === '24x7') {
    return new Date(start.getTime() + minutes * 60_000);
  }
  // 8x5: walk forward over Mon–Fri 09:00–17:00 windows, skipping weekends and holidays
  // (computed in UTC for determinism; production uses the calendar's IANA tz — see §H.4).
  const holidays = new Set(cal.holidays ?? []);
  let remaining = minutes;
  const cursor = new Date(start);
  const dailyMinutes = (BUSINESS_END_HOUR - BUSINESS_START_HOUR) * 60;

  while (remaining > 0) {
    const day = cursor.getUTCDay(); // 0 Sun .. 6 Sat
    const isWeekend = day === 0 || day === 6;
    const isHoliday = holidays.has(isoDate(cursor));
    if (isWeekend || isHoliday) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    const hour = cursor.getUTCHours();
    if (hour < BUSINESS_START_HOUR) {
      cursor.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    if (hour >= BUSINESS_END_HOUR) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    // minutes left in today's business window
    const endOfDay = new Date(cursor);
    endOfDay.setUTCHours(BUSINESS_END_HOUR, 0, 0, 0);
    const availToday = Math.min(
      dailyMinutes,
      Math.floor((endOfDay.getTime() - cursor.getTime()) / 60_000),
    );
    const take = Math.min(remaining, availToday);
    cursor.setTime(cursor.getTime() + take * 60_000);
    remaining -= take;
    if (remaining > 0) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
    }
  }
  return cursor;
}

export function targetMinutes(priority: string, metric: SlaMetric): number {
  return DEFAULT_TARGETS_MINUTES[priority]?.[metric] ?? DEFAULT_TARGETS_MINUTES.P3[metric];
}

/** Load an org's business calendar (coverage, tz, holidays) with sane defaults. */
export async function loadCalendar(sql: Sql, organizationId: string): Promise<CalendarLike> {
  const { rows } = await sql.query(
    `SELECT coverage, tz, COALESCE(holidays, '{}') AS holidays FROM business_calendars
      WHERE organization_id=$1 LIMIT 1`,
    [organizationId],
  );
  const row = rows[0];
  if (!row) return { coverage: '8x5', tz: 'America/New_York' };
  return {
    coverage: (row.coverage as CalendarLike['coverage']) ?? '8x5',
    tz: row.tz ?? 'America/New_York',
    // pg returns date[] as Date objects or strings depending on parser; normalize to ISO.
    holidays: (row.holidays as Array<string | Date>).map((h) => (h instanceof Date ? isoDate(h) : String(h).slice(0, 10))),
  };
}

/** Create response + resolution SLA instances for a newly-created ticket. */
export async function startTicketSla(
  sql: Sql,
  ticket: { id: string; organization_id: string; priority: string },
  cal?: CalendarLike,
): Promise<{ response_due_at: Date; resolution_due_at: Date }> {
  if (!cal) cal = await loadCalendar(sql, ticket.organization_id);
  const now = new Date();
  const responseDue = addBusinessMinutes(now, targetMinutes(ticket.priority, 'response'), cal);
  const resolutionDue = addBusinessMinutes(now, targetMinutes(ticket.priority, 'resolution'), cal);

  for (const [metric, due] of [
    ['response', responseDue],
    ['resolution', resolutionDue],
  ] as const) {
    await sql.query(
      `INSERT INTO sla_instances (organization_id, ticket_id, metric, started_at, due_at, state)
       VALUES ($1,$2,$3,$4,$5,'running')`,
      [ticket.organization_id, ticket.id, metric, now, due],
    );
  }
  return { response_due_at: responseDue, resolution_due_at: resolutionDue };
}

/** Mark the response SLA met on first response (agent reply / assignment / work
 *  started). Idempotent and never un-breaches: a genuinely late first response
 *  stays 'breached' for reporting. Returns true if a running/warning instance was met. */
export async function markResponseMet(sql: Sql, ticketId: string): Promise<boolean> {
  const { rowCount } = await sql.query(
    `UPDATE sla_instances SET state='met'
      WHERE ticket_id=$1 AND metric='response' AND state IN ('running','warning','paused')`,
    [ticketId],
  );
  return (rowCount ?? 0) > 0;
}

export type SlaState = 'running' | 'paused' | 'warning' | 'met' | 'breached';

/** Pure evaluation of an instance's current state (for the periodic sweep). */
export function evaluateState(
  instance: { started_at: Date; due_at: Date; state: string },
  now = new Date(),
): SlaState {
  if (instance.state === 'met' || instance.state === 'breached') return instance.state as SlaState;
  // A paused instance's clock is frozen — it never warns or breaches until resumed.
  if (instance.state === 'paused') return 'paused';
  const total = instance.due_at.getTime() - instance.started_at.getTime();
  const consumed = now.getTime() - instance.started_at.getTime();
  if (now >= instance.due_at) return 'breached';
  if (total > 0 && consumed / total >= 0.75) return 'warning';
  return 'running';
}

// ---- Pause / resume (docs/nexus/04 §H.4) ----

export interface PausableInstance {
  state: string;
  due_at: Date;
  paused_at: Date | null;
  paused_minutes: number;
}

/** Compute the fields to pause a running instance. Pure; idempotent (no-op if not running). */
export function applyPause(instance: PausableInstance, now = new Date()): Partial<PausableInstance> | null {
  if (instance.state !== 'running' && instance.state !== 'warning') return null;
  return { state: 'paused', paused_at: now };
}

/** Compute the fields to resume a paused instance: shift due_at forward by the paused
 *  duration so remaining work-time is preserved, and accumulate paused_minutes. Pure. */
export function applyResume(instance: PausableInstance, now = new Date()): Partial<PausableInstance> | null {
  if (instance.state !== 'paused' || !instance.paused_at) return null;
  const elapsedMs = Math.max(0, now.getTime() - new Date(instance.paused_at).getTime());
  return {
    state: 'running',
    paused_at: null,
    due_at: new Date(new Date(instance.due_at).getTime() + elapsedMs),
    paused_minutes: instance.paused_minutes + Math.round(elapsedMs / 60_000),
  };
}

/** Pause all running/warning SLA instances on a ticket (e.g. on hold / waiting on customer). */
export async function pauseTicketSlas(sql: Sql, ticketId: string, now = new Date()): Promise<number> {
  const { rowCount } = await sql.query(
    `UPDATE sla_instances SET state='paused', paused_at=$2
      WHERE ticket_id=$1 AND state IN ('running','warning')`,
    [ticketId, now],
  );
  return rowCount ?? 0;
}

/** Resume all paused SLA instances on a ticket, shifting due_at by the paused duration. */
export async function resumeTicketSlas(sql: Sql, ticketId: string, now = new Date()): Promise<number> {
  const { rows } = await sql.query(
    `SELECT id, state, due_at, paused_at, paused_minutes FROM sla_instances
      WHERE ticket_id=$1 AND state='paused'`,
    [ticketId],
  );
  let resumed = 0;
  for (const r of rows) {
    const next = applyResume(
      { state: r.state, due_at: new Date(r.due_at), paused_at: r.paused_at ? new Date(r.paused_at) : null, paused_minutes: r.paused_minutes },
      now,
    );
    if (!next) continue;
    await sql.query(
      `UPDATE sla_instances SET state='running', paused_at=NULL, due_at=$2, paused_minutes=$3 WHERE id=$1`,
      [r.id, next.due_at, next.paused_minutes],
    );
    resumed++;
  }
  return resumed;
}
