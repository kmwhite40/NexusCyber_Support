import { describe, it, expect, vi } from 'vitest';
import { activeGrantsFor } from '../src/modules/elevation.js';

// Regression guard for the admin-pool deadlock: loadPrincipal calls activeGrantsFor
// from inside its own withSystemContext, so activeGrantsFor MUST be able to reuse the
// caller's connection rather than acquiring a second one (which deadlocks the bounded
// admin pool under concurrency). When given a client it must run on that client and
// open no new connection.
describe('activeGrantsFor', () => {
  it('runs on a provided client without acquiring a new connection', async () => {
    const sql = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'g1',
            user_id: 'u1',
            granted_permissions: ['x'],
            status: 'active',
            break_glass: false,
            expires_at: null,
          },
        ],
      })),
    } as any;

    const out = await activeGrantsFor('u1', sql);

    expect(sql.query).toHaveBeenCalledTimes(1);
    expect(sql.query.mock.calls[0][1]).toEqual(['u1']);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('g1');
  });
});
