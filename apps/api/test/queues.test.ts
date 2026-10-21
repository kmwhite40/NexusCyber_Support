import { describe, it, expect } from 'vitest';
import { buildQueueWhere, orderExpression } from '../src/modules/queues.js';

describe('buildQueueWhere', () => {
  it('hides closed tickets for an empty definition', () => {
    expect(buildQueueWhere({})).toEqual({ clauses: ["t.status <> 'closed'"], params: [] });
  });
  it('handles a single-value status and priority', () => {
    const r = buildQueueWhere({ status: 'in_progress', priority: 'P1' });
    expect(r.clauses).toEqual(['t.status = $1', 't.priority = $2']);
    expect(r.params).toEqual(['in_progress', 'P1']);
  });
  it('handles array values with ANY()', () => {
    const r = buildQueueWhere({ status: ['triage', 'assigned'] });
    expect(r.clauses).toEqual(['t.status = ANY($1)']);
    expect(r.params).toEqual([['triage', 'assigned']]);
  });
  it('adds an unassigned predicate without a param', () => {
    const r = buildQueueWhere({ unassigned: true });
    expect(r.clauses).toEqual(["t.status <> 'closed'", 't.assigned_agent_id IS NULL']);
    expect(r.params).toEqual([]);
  });
  it('respects a custom start index for params', () => {
    const r = buildQueueWhere({ tag: 'security' }, 3);
    expect(r.clauses).toEqual(["t.status <> 'closed'", '$3 = ANY(t.tags)']);
    expect(r.params).toEqual(['security']);
  });
});

// Closed tickets live in Archived. A queue with no status filter (the seeded "P1 incidents"
// and "Security" queues) would otherwise list every closed ticket it ever matched.
describe('buildQueueWhere closed-ticket handling', () => {
  it('excludes closed when the queue has no status filter', () => {
    const r = buildQueueWhere({ priority: 'P1' });
    expect(r.clauses).toEqual(["t.status <> 'closed'", 't.priority = $1']);
    expect(r.params).toEqual(['P1']);
  });
  it('includes closed when the caller asks for it', () => {
    const r = buildQueueWhere({ priority: 'P1' }, 1, { includeClosed: true });
    expect(r.clauses).toEqual(['t.priority = $1']);
    expect(r.params).toEqual(['P1']);
  });
  it('leaves a queue that lists closed alone', () => {
    expect(buildQueueWhere({ status: 'closed' }).clauses).toEqual(['t.status = $1']);
    expect(buildQueueWhere({ status: ['resolved', 'closed'] }).clauses).toEqual(['t.status = ANY($1)']);
  });
  it('adds no exclusion to a status list that already omits closed', () => {
    expect(buildQueueWhere({ status: ['triage'] }).clauses).toEqual(['t.status = ANY($1)']);
  });
  it('does not widen an explicit status list when closed is included', () => {
    const r = buildQueueWhere({ status: 'in_progress' }, 1, { includeClosed: true });
    expect(r.clauses).toEqual(['t.status = $1']);
    expect(r.params).toEqual(['in_progress']);
  });
});

describe('orderExpression', () => {
  it('defaults to SLA-soonest', () => {
    expect(orderExpression('sla')).toMatch(/next_sla_due ASC NULLS LAST/);
    expect(orderExpression('anything')).toMatch(/next_sla_due/);
  });
  it('supports priority and created sorts', () => {
    expect(orderExpression('priority')).toMatch(/P1.*THEN 1/);
    expect(orderExpression('created')).toBe('t.created_at DESC');
  });
});
