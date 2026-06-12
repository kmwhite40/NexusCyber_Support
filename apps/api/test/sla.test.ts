import { describe, it, expect } from 'vitest';
import { addBusinessMinutes, evaluateState, targetMinutes, applyPause, applyResume, isoDate } from '../src/modules/sla.js';

describe('SLA engine', () => {
  it('targetMinutes returns priority-specific targets with P3 fallback', () => {
    expect(targetMinutes('P1', 'response')).toBe(15);
    expect(targetMinutes('P2', 'resolution')).toBe(8 * 60);
    expect(targetMinutes('NOPE', 'response')).toBe(targetMinutes('P3', 'response'));
  });

  it('24x7 calendar adds wall-clock minutes', () => {
    const start = new Date('2026-01-05T10:00:00Z');
    const out = addBusinessMinutes(start, 120, { coverage: '24x7', tz: 'UTC' });
    expect(out.toISOString()).toBe('2026-01-05T12:00:00.000Z');
  });

  it('8x5 calendar skips the weekend', () => {
    // Saturday 10:00 + 60 business minutes -> Monday 10:00 (business window 09:00–17:00 UTC)
    const sat = new Date('2026-01-03T10:00:00Z');
    const out = addBusinessMinutes(sat, 60, { coverage: '8x5', tz: 'UTC' });
    expect(out.toISOString()).toBe('2026-01-05T10:00:00.000Z');
  });

  it('8x5 rolls past end-of-day into the next business day', () => {
    // Monday 16:00 + 120 business minutes -> Mon 16:00→17:00 (60) then Tue 09:00 +60 = Tue 10:00
    const mon = new Date('2026-01-05T16:00:00Z');
    const out = addBusinessMinutes(mon, 120, { coverage: '8x5', tz: 'UTC' });
    expect(out.toISOString()).toBe('2026-01-06T10:00:00.000Z');
  });

  it('evaluateState transitions running -> warning -> breached', () => {
    const started = new Date('2026-01-05T00:00:00Z');
    const due = new Date(started.getTime() + 100 * 60_000);
    const inst = { started_at: started, due_at: due, state: 'running' };
    expect(evaluateState(inst, new Date(started.getTime() + 50 * 60_000))).toBe('running');
    expect(evaluateState(inst, new Date(started.getTime() + 80 * 60_000))).toBe('warning');
    expect(evaluateState(inst, new Date(due.getTime() + 60_000))).toBe('breached');
  });

  it('evaluateState is terminal once met or breached', () => {
    const started = new Date('2026-01-05T00:00:00Z');
    const due = new Date(started.getTime() + 100 * 60_000);
    expect(evaluateState({ started_at: started, due_at: due, state: 'met' }, new Date(due.getTime() + 1e9))).toBe('met');
    expect(evaluateState({ started_at: started, due_at: due, state: 'breached' }, started)).toBe('breached');
  });

  it('8x5 calendar skips holidays like weekends', () => {
    // Monday 2026-01-05 is a holiday -> 60 min from Mon 10:00 lands Tue 10:00.
    const mon = new Date('2026-01-05T10:00:00Z');
    const out = addBusinessMinutes(mon, 60, { coverage: '8x5', tz: 'UTC', holidays: ['2026-01-05'] });
    expect(out.toISOString()).toBe('2026-01-06T10:00:00.000Z');
  });

  it('a paused instance never warns or breaches', () => {
    const started = new Date('2026-01-05T00:00:00Z');
    const due = new Date(started.getTime() + 100 * 60_000);
    expect(evaluateState({ started_at: started, due_at: due, state: 'paused' }, new Date(due.getTime() + 1e9))).toBe('paused');
  });
});

describe('SLA pause/resume', () => {
  const base = { state: 'running', due_at: new Date('2026-01-05T12:00:00Z'), paused_at: null as Date | null, paused_minutes: 0 };

  it('applyPause marks a running instance paused', () => {
    const at = new Date('2026-01-05T10:00:00Z');
    expect(applyPause(base, at)).toEqual({ state: 'paused', paused_at: at });
  });
  it('applyPause is a no-op for non-running states', () => {
    expect(applyPause({ ...base, state: 'met' })).toBeNull();
    expect(applyPause({ ...base, state: 'paused' })).toBeNull();
  });
  it('applyResume shifts due_at forward by the paused duration and accumulates minutes', () => {
    const pausedAt = new Date('2026-01-05T10:00:00Z');
    const resumeAt = new Date('2026-01-05T10:30:00Z'); // 30 minutes paused
    const next = applyResume({ state: 'paused', due_at: new Date('2026-01-05T12:00:00Z'), paused_at: pausedAt, paused_minutes: 0 }, resumeAt);
    expect(next).not.toBeNull();
    expect(next!.state).toBe('running');
    expect((next!.due_at as Date).toISOString()).toBe('2026-01-05T12:30:00.000Z');
    expect(next!.paused_minutes).toBe(30);
  });
  it('applyResume is a no-op when not paused', () => {
    expect(applyResume(base)).toBeNull();
  });
});

describe('isoDate', () => {
  it('formats the UTC calendar date', () => {
    expect(isoDate(new Date('2026-03-09T23:59:00Z'))).toBe('2026-03-09');
  });
});
