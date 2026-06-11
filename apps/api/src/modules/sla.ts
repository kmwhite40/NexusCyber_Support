// SLA engine (docs/nexus/04 §H, ADR-011). One engine serves all ticket types.
// This reference implements: target resolution by priority, due-date computation
// (business-hours-aware for 8x5 calendars), and state evaluation with idempotent
// warning/breach. A production engine adds holidays, maintenance windows, and the
// nightly reconciliation sweep.
import type { Sql } from '../db/pool.js';

export type SlaMetric = 'response' | 'resolution' | 'update' | 'remediation';

const DEFAULT_TARGETS_MINUTES: Record<string, Record<SlaMetric, number>> = {
  // priority -> metric -> minutes (business minutes)
  P1: { response: 15, resolution: 4 * 60, update: 60, remediation: 7 * 24 * 60 },
  P2: { response: 30, resolution: 8 * 60, update: 120, remediation: 30 * 24 * 60 },
  P3: { response: 60, resolution: 24 * 60, update: 240, remediation: 90 * 24 * 60 },
  P4: { response: 120, resolution: 72 * 60, update: 480, remediation: 90 * 24 * 60 },
};

interface CalendarLike {
  coverage: '8x5' | '24x7';
  tz: string;
}

const BUSINESS_START_HOUR = 9; // local 09:00–17:00 for 8x5
const BUSINESS_END_HOUR = 17;

/** Add N business minutes from `start` honoring an 8x5 or 24x7 calendar. */
export function addBusinessMinutes(start: Date, minutes: number, cal: CalendarLike): Date {
  if (cal.coverage === '24x7') {
    return new Date(start.getTime() + minutes * 60_000);
  }
  // 8x5: walk forward over Mon–Fri 09:00–17:00 windows (computed in UTC for determinism;
  // production uses the calendar's IANA tz — see docs/nexus/04 §H.4).
  let remaining = minutes;
  const cursor = new Date(start);
  const dailyMinutes = (BUSINESS_END_HOUR - BUSINESS_START_HOUR) * 60;

  while (remaining > 0) {
    const day = cursor.getUTCDay(); // 0 Sun .. 6 Sat
    const isWeekend = day === 0 || day === 6;
    if (isWeekend) {
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

/** Create response + resolution SLA instances for a newly-created ticket. */
export async function startTicketSla(
  sql: Sql,
  ticket: { id: string; organization_id: string; priority: string },
  cal: CalendarLike = { coverage: '8x5', tz: 'America/New_York' },
): Promise<{ response_due_at: Date; resolution_due_at: Date }> {
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

export type SlaState = 'running' | 'warning' | 'met' | 'breached';

/** Pure evaluation of an instance's current state (for the periodic sweep). */
export function evaluateState(
  instance: { started_at: Date; due_at: Date; state: string },
  now = new Date(),
): SlaState {
  if (instance.state === 'met' || instance.state === 'breached') return instance.state as SlaState;
  const total = instance.due_at.getTime() - instance.started_at.getTime();
  const consumed = now.getTime() - instance.started_at.getTime();
  if (now >= instance.due_at) return 'breached';
  if (total > 0 && consumed / total >= 0.75) return 'warning';
  return 'running';
}
