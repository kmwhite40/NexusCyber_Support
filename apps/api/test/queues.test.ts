import { describe, it, expect } from 'vitest';
import { buildQueueWhere, orderExpression } from '../src/modules/queues.js';

describe('buildQueueWhere', () => {
  it('builds nothing for an empty definition', () => {
    expect(buildQueueWhere({})).toEqual({ clauses: [], params: [] });
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
    expect(r.clauses).toEqual(['t.assigned_agent_id IS NULL']);
    expect(r.params).toEqual([]);
  });
  it('respects a custom start index for params', () => {
    const r = buildQueueWhere({ tag: 'security' }, 3);
    expect(r.clauses).toEqual(['$3 = ANY(t.tags)']);
    expect(r.params).toEqual(['security']);
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
