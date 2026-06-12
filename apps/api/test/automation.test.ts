import { describe, it, expect } from 'vitest';
import { evalCondition, evaluateConditions, planActions, type RuleDefinition } from '../src/modules/automation.js';
import { IdempotencyStore } from '../src/http/idempotency.js';

describe('Automation — condition evaluation', () => {
  const ctx = { priority: 'P1', type: 'incident', tags: ['security'], impact: 2 };

  it('evaluates each operator', () => {
    expect(evalCondition({ field: 'priority', op: 'eq', value: 'P1' }, ctx)).toBe(true);
    expect(evalCondition({ field: 'priority', op: 'neq', value: 'P2' }, ctx)).toBe(true);
    expect(evalCondition({ field: 'priority', op: 'in', value: ['P1', 'P2'] }, ctx)).toBe(true);
    expect(evalCondition({ field: 'impact', op: 'lte', value: 3 }, ctx)).toBe(true);
    expect(evalCondition({ field: 'impact', op: 'gte', value: 5 }, ctx)).toBe(false);
    expect(evalCondition({ field: 'tags', op: 'contains', value: 'security' }, ctx)).toBe(true);
    expect(evalCondition({ field: 'type', op: 'exists' }, ctx)).toBe(true);
    expect(evalCondition({ field: 'missing', op: 'exists' }, ctx)).toBe(false);
  });

  it('all/any groups combine correctly', () => {
    expect(evaluateConditions({ all: [{ field: 'priority', op: 'eq', value: 'P1' }, { field: 'type', op: 'eq', value: 'incident' }] }, ctx)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'priority', op: 'eq', value: 'P2' }] }, ctx)).toBe(false);
    expect(evaluateConditions({ any: [{ field: 'priority', op: 'eq', value: 'P2' }, { field: 'type', op: 'eq', value: 'incident' }] }, ctx)).toBe(true);
    expect(evaluateConditions(undefined, ctx)).toBe(true);
  });
});

describe('Automation — action planning & human-in-the-loop gating', () => {
  const def: RuleDefinition = {
    trigger: { event: 'ticket.created' },
    conditions: { all: [{ field: 'priority', op: 'eq', value: 'P1' }] },
    actions: [
      { type: 'add_internal_note', text: 'safe' },
      { type: 'notify_user', text: 'customer-visible' },
    ],
  };

  it('returns no actions when conditions fail', () => {
    expect(planActions(def, { priority: 'P3' })).toEqual([]);
  });

  it('performs safe actions but gates customer-visible ones', () => {
    const plan = planActions(def, { priority: 'P1' });
    const note = plan.find((p) => p.action.type === 'add_internal_note')!;
    const notify = plan.find((p) => p.action.type === 'notify_user')!;
    expect(note.performed).toBe(true);
    expect(note.gated).toBe(false);
    expect(notify.performed).toBe(false); // requires human approval
    expect(notify.gated).toBe(true);
  });
});

describe('Idempotency store', () => {
  it('replays within TTL and expires after', () => {
    let now = 1000;
    const store = new IdempotencyStore(500, () => now);
    store.set('k', { status: 201, payload: '{"id":1}' });
    expect(store.get('k')?.status).toBe(201);
    now = 1400; // within TTL
    expect(store.get('k')).toBeDefined();
    now = 1600; // past TTL
    expect(store.get('k')).toBeUndefined();
  });

  it('returns undefined for unknown keys', () => {
    expect(new IdempotencyStore().get('nope')).toBeUndefined();
  });
});
