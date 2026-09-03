import { describe, it, expect } from 'vitest';
import { rejectSensitiveCustomFields } from '../src/modules/tickets.js';
import { ApiError } from '../src/errors.js';

// createTicket (the M2M / external-GRC integration path, migration 0051) has no form
// definition to validate customFields against — unlike the catalog intake path, which knows
// per-key `sensitive` flags and routes those answers to ticket_sensitive_fields instead.
// rejectSensitiveCustomFields is the pure decision it borrows from the same source of truth
// (form_fields.sensitive) to keep PII-shaped key names out of tickets.custom_fields, which is
// returned wholesale on ticket reads and feeds notifications/webhooks. DB wiring (the query
// that gathers the current sensitive key set from Postgres) is exercised in
// test/integration/tickets-sensitive-fields.int.test.ts.
const SENSITIVE = new Set(['personal_email', 'cell_phone', 'home_address_street', 'home_address_csz']);

describe('rejectSensitiveCustomFields', () => {
  it('does nothing when customFields is absent', () => {
    expect(() => rejectSensitiveCustomFields(undefined, SENSITIVE)).not.toThrow();
  });

  it('does nothing when no key collides with a known-sensitive field name', () => {
    expect(() =>
      rejectSensitiveCustomFields({ severity_note: 'p1', vendor_ticket_id: 'V-123' }, SENSITIVE),
    ).not.toThrow();
  });

  it('throws a 422 ApiError when a key collides with a known-sensitive field name', () => {
    expect(() => rejectSensitiveCustomFields({ personal_email: 'a@b.com' }, SENSITIVE)).toThrow(ApiError);
    try {
      rejectSensitiveCustomFields({ personal_email: 'a@b.com' }, SENSITIVE);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect((err as ApiError).detail).toContain('personal_email');
    }
  });

  it('lists every offending key, not just the first', () => {
    try {
      rejectSensitiveCustomFields({ cell_phone: 'x', home_address_street: 'y', ok: 'z' }, SENSITIVE);
      expect.fail('expected throw');
    } catch (err) {
      const detail = (err as ApiError).detail ?? '';
      expect(detail).toContain('cell_phone');
      expect(detail).toContain('home_address_street');
      expect(detail).not.toContain('"ok"');
    }
  });

  it('is a no-op against an empty sensitive-key set (e.g. no forms configured yet)', () => {
    expect(() => rejectSensitiveCustomFields({ personal_email: 'a@b.com' }, new Set())).not.toThrow();
  });
});
