import { describe, it, expect } from 'vitest';
import { nextRunState } from '../src/jobs/cloudpc-poller.js';

const start = new Date('2026-09-01T00:00:00Z');
const DEADLINE = 4 * 60 * 60 * 1000;

describe('nextRunState', () => {
  it('completes the run once the Cloud PC reports provisioned', () => {
    expect(nextRunState('provisioned', start, new Date('2026-09-01T00:40:00Z'), DEADLINE))
      .toEqual({ status: 'succeeded', error: null });
  });

  it('keeps waiting while the build is in progress', () => {
    expect(nextRunState('provisioning', start, new Date('2026-09-01T00:40:00Z'), DEADLINE))
      .toEqual({ status: 'awaiting_cloudpc', error: null });
  });

  it('keeps waiting when the Cloud PC has not appeared yet', () => {
    expect(nextRunState(null, start, new Date('2026-09-01T00:05:00Z'), DEADLINE).status)
      .toBe('awaiting_cloudpc');
  });

  it('fails the run once the deadline passes', () => {
    const r = nextRunState('provisioning', start, new Date('2026-09-01T05:00:00Z'), DEADLINE);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/deadline/i);
  });

  it('fails immediately on a terminal Graph failure state', () => {
    expect(nextRunState('failed', start, new Date('2026-09-01T00:40:00Z'), DEADLINE).status)
      .toBe('failed');
  });
});
