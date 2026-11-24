import { describe, it, expect } from 'vitest';
import { planTicketEdit, SUBJECT_MAX, type EditableTicket } from '../src/modules/ticket-admin.js';
import { retargetDue } from '../src/modules/sla.js';

// The decision logic behind PATCH /tickets/:id is pure and pinned here; the DB-backed path
// (permission, org scope, transaction, SLA move, event + audit, reassignment validation) is
// covered by test/integration/ticket-admin.int.test.ts.

const ticket = (over: Partial<EditableTicket> = {}): EditableTicket => ({
  status: 'in_progress',
  subject: 'Laptop will not boot',
  description: 'Black screen after update',
  category: 'hardware',
  impact: 3,
  urgency: 3,
  priority: 'P3',
  ...over,
});

describe('planTicketEdit', () => {
  it('changes only the fields sent, trimmed', () => {
    const p = planTicketEdit(ticket(), { subject: '  Laptop will not power on  ' });
    expect(p.errors).toEqual([]);
    expect(p.update).toEqual({ subject: 'Laptop will not power on' });
    expect(p.changes).toEqual([{ field: 'subject', from: 'Laptop will not boot', to: 'Laptop will not power on' }]);
    expect(p.priorityChanged).toBe(false);
  });

  it('drops no-op keys so an unchanged form produces no changes', () => {
    const p = planTicketEdit(ticket(), { subject: 'Laptop will not boot', category: 'hardware', impact: 3, urgency: 3 });
    expect(p.errors).toEqual([]);
    expect(p.changes).toEqual([]);
  });

  it('re-derives priority from impact x urgency, as at creation', () => {
    const p = planTicketEdit(ticket(), { impact: 1, urgency: 1 });
    expect(p.update).toMatchObject({ impact: 1, urgency: 1, priority: 'P1' });
    expect(p.priorityChanged).toBe(true);
    expect(p.changes.find((c) => c.field === 'priority')).toEqual({ field: 'priority', from: 'P3', to: 'P1' });
  });

  it('combines a changed impact with the stored urgency', () => {
    const p = planTicketEdit(ticket({ urgency: 2 }), { impact: 2 });
    expect(p.update.priority).toBe('P2'); // matrix[2][2]
  });

  it('does not report a priority change when the derived priority is the same', () => {
    const p = planTicketEdit(ticket(), { impact: 4, urgency: 2 }); // matrix[4][2] = P3
    expect(p.update).not.toHaveProperty('priority');
    expect(p.priorityChanged).toBe(false);
  });

  it('clears description and category with blank or null', () => {
    const p = planTicketEdit(ticket(), { description: '   ', category: null });
    expect(p.update).toEqual({ description: null, category: null });
  });

  it('rejects an empty or over-long subject and out-of-range levels', () => {
    expect(planTicketEdit(ticket(), { subject: '  ' }).errors).toEqual([{ field: 'subject', message: 'subject cannot be empty' }]);
    expect(planTicketEdit(ticket(), { subject: 'x'.repeat(SUBJECT_MAX + 1) }).errors[0].field).toBe('subject');
    expect(planTicketEdit(ticket(), { impact: 0 }).errors[0].field).toBe('impact');
    expect(planTicketEdit(ticket(), { urgency: 5 }).errors[0].field).toBe('urgency');
    expect(planTicketEdit(ticket(), { urgency: 2.5 }).errors[0].field).toBe('urgency');
  });

  it('refuses any edit on a closed ticket but allows a resolved one', () => {
    expect(planTicketEdit(ticket({ status: 'closed' }), { subject: 'x' }).errors[0].field).toBe('status');
    expect(planTicketEdit(ticket({ status: 'resolved' }), { subject: 'x' }).errors).toEqual([]);
  });
});

describe('retargetDue', () => {
  const cal = { coverage: '24x7' as const, tz: 'UTC' };
  const started = new Date('2026-11-02T10:00:00Z');

  it('re-times a live clock from its original start with the new priority target', () => {
    const due = retargetDue({ metric: 'response', state: 'running', started_at: started, paused_minutes: 0 }, 'P1', cal);
    expect(due?.toISOString()).toBe('2026-11-02T11:00:00.000Z'); // P1 response = 60 min
  });

  it('keeps time already spent paused, and re-targets paused and warning clocks too', () => {
    const paused = retargetDue({ metric: 'resolution', state: 'paused', started_at: started, paused_minutes: 30 }, 'P1', cal);
    expect(paused?.toISOString()).toBe('2026-11-02T14:30:00.000Z'); // 4h + 30m paused
    expect(retargetDue({ metric: 'response', state: 'warning', started_at: started, paused_minutes: 0 }, 'P1', cal)).not.toBeNull();
  });

  it('never moves a met or breached clock', () => {
    expect(retargetDue({ metric: 'response', state: 'met', started_at: started, paused_minutes: 0 }, 'P1', cal)).toBeNull();
    expect(retargetDue({ metric: 'response', state: 'breached', started_at: started, paused_minutes: 0 }, 'P4', cal)).toBeNull();
  });
});
