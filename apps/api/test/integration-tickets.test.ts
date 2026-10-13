import { describe, it, expect } from 'vitest';
import { parseIntegrationTicket } from '../src/modules/integration-tickets.js';
import { ApiError } from '../src/errors.js';

const ORG = '5793f502-0000-4000-8000-000000000001';

function payload(over: Record<string, unknown> = {}) {
  return {
    externalRef: 'carbon-conmon:poam:p-118',
    organizationId: ORG,
    source: 'poam',
    title: 'Patch CVE-2026-1234 on the web tier',
    ...over,
  };
}

describe('parseIntegrationTicket — renaming', () => {
  it('maps the consumer vocabulary onto Anchor field names', () => {
    const { input } = parseIntegrationTicket(
      payload({
        description: 'KEV-listed',
        labels: ['poam', 'grc'],
        metadata: { carbonFindingId: 'f-1' },
        sourceId: 'p-118',
        owner: 'Platform Team',
        controlIds: ['CA-7'],
        dueDate: '2026-11-30T00:00:00Z',
        carbonUrl: 'https://example.gov/a/1',
      }),
    );
    expect(input.subject).toBe('Patch CVE-2026-1234 on the web tier');
    expect(input.externalSource).toBe('poam');
    expect(input.tags).toEqual(['poam', 'grc']);
    expect(input.customFields).toEqual({ carbonFindingId: 'f-1' });
    expect(input.integration).toMatchObject({
      sourceId: 'p-118',
      owner: 'Platform Team',
      controlIds: ['CA-7'],
      url: 'https://example.gov/a/1',
    });
    expect(input.integration?.dueAt).toBe('2026-11-30T00:00:00Z');
  });

  it('omits integration keys the caller did not send, so an upsert preserves them', () => {
    const { input } = parseIntegrationTicket(payload({ owner: 'A' }));
    expect('owner' in (input.integration ?? {})).toBe(true);
    expect('dueAt' in (input.integration ?? {})).toBe(false);
    expect('controlIds' in (input.integration ?? {})).toBe(false);
  });

  it('keeps an explicit null so the upsert can clear the column', () => {
    const { input } = parseIntegrationTicket(payload({ dueDate: null }));
    expect('dueAt' in (input.integration ?? {})).toBe(true);
    expect(input.integration?.dueAt).toBeNull();
  });
});

describe('parseIntegrationTicket — severity drives priority', () => {
  it.each([
    ['critical', 1, 1],
    ['high', 2, 2],
    ['medium', 3, 3],
    ['low', 4, 4],
  ])('maps %s to impact/urgency %i/%i', (severity, impact, urgency) => {
    const { input } = parseIntegrationTicket(payload({ severity }));
    expect(input.impact).toBe(impact);
    expect(input.urgency).toBe(urgency);
    expect(input.severity).toBe(severity);
  });

  it('defaults a null severity to 3/3 and stores no severity', () => {
    const { input } = parseIntegrationTicket(payload({ severity: null }));
    expect(input.impact).toBe(3);
    expect(input.urgency).toBe(3);
    expect(input.severity).toBeUndefined();
  });
});

describe('parseIntegrationTicket — the three tiers', () => {
  it('reports status, priority and tenantId as ignored rather than dropping them', () => {
    const { ignored } = parseIntegrationTicket(
      payload({ status: 'open', priority: 'P0', tenantId: null }),
    );
    expect(ignored.sort()).toEqual(['priority', 'status', 'tenantId']);
  });

  it('reports nothing as ignored when none were sent', () => {
    expect(parseIntegrationTicket(payload()).ignored).toEqual([]);
  });

  it('refuses an unrecognised field with a 422 naming it', () => {
    try {
      parseIntegrationTicket(payload({ wobble: 1 }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(422);
      expect(e.errors?.map((x) => x.field)).toContain('wobble');
    }
  });

  it('refuses a phase-D backlog field and says so', () => {
    try {
      parseIntegrationTicket(payload({ parentExternalRef: 'carbon-conmon:backlog:WS-1' }));
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as ApiError;
      expect(e.status).toBe(422);
      expect(e.errors?.[0].field).toBe('parentExternalRef');
      expect(e.detail).toMatch(/phase D/i);
    }
  });
});

describe('parseIntegrationTicket — required and bounded fields', () => {
  it('requires title, externalRef and organizationId', () => {
    const e = (() => {
      try {
        parseIntegrationTicket({ source: 'poam' });
      } catch (err) {
        return err as ApiError;
      }
    })();
    expect(e?.status).toBe(422);
    const fields = e?.errors?.map((x) => x.field) ?? [];
    expect(fields).toContain('title');
    expect(fields).toContain('externalRef');
    expect(fields).toContain('organizationId');
  });

  it('accepts an externalRef whose first segment is not a uuid', () => {
    const { input } = parseIntegrationTicket(payload({ externalRef: 'carbon-conmon:backlog:WS-1.1' }));
    expect(input.externalRef).toBe('carbon-conmon:backlog:WS-1.1');
  });

  it('refuses a 201-character externalRef with a 422 (Review Focus 3)', () => {
    const e = (() => {
      try {
        parseIntegrationTicket(payload({ externalRef: 'x'.repeat(201) }));
      } catch (err) {
        return err as ApiError;
      }
    })();
    expect(e?.status).toBe(422);
    expect(e?.errors?.map((x) => x.field)).toContain('externalRef');
  });

  it('refuses a non-object body', () => {
    expect(() => parseIntegrationTicket('nope')).toThrow(ApiError);
    expect(() => parseIntegrationTicket(null)).toThrow(ApiError);
    expect(() => parseIntegrationTicket([])).toThrow(ApiError);
  });
});

import { serializeIntegrationTicket, isExternalRefConflict } from '../src/modules/integration-tickets.js';

describe('serializeIntegrationTicket', () => {
  const row = {
    id: 'a1', ticket_number: 'DEMO-000123', external_ref: 'carbon-conmon:poam:p-118',
    status: 'triage', external_due_at: new Date('2026-11-30T00:00:00Z'),
    created_at: new Date('2026-10-13T10:00:00Z'), updated_at: new Date('2026-10-13T10:00:01Z'),
  };

  it('exposes the integration shape, not the ticket row', () => {
    const out = serializeIntegrationTicket(row, true, ['status'], null);
    expect(out).toEqual({
      ticketId: 'a1',
      ticketKey: 'DEMO-000123',
      externalRef: 'carbon-conmon:poam:p-118',
      status: 'triage',
      assignee: null,
      dueDate: '2026-11-30T00:00:00.000Z',
      createdAt: '2026-10-13T10:00:00.000Z',
      updatedAt: '2026-10-13T10:00:01.000Z',
      created: true,
      ignored: ['status'],
    });
  });

  it('echoes the caller due date, never the SLA clock', () => {
    const out = serializeIntegrationTicket(
      { ...row, external_due_at: null, resolution_due_at: new Date('2026-10-14T00:00:00Z') },
      false, [], null,
    );
    expect(out.dueDate).toBeNull();
  });

  it('reports the assignee it was given', () => {
    expect(serializeIntegrationTicket(row, false, [], 'a@example.gov').assignee).toBe('a@example.gov');
  });
});

describe('isExternalRefConflict', () => {
  it('recognises the unique-index violation on external_ref', () => {
    expect(isExternalRefConflict({ code: '23505', constraint: 'ux_tickets_org_external_ref' })).toBe(true);
  });

  it('ignores other unique violations and non-pg errors', () => {
    expect(isExternalRefConflict({ code: '23505', constraint: 'tickets_organization_id_ticket_number_key' })).toBe(false);
    expect(isExternalRefConflict(new Error('boom'))).toBe(false);
    expect(isExternalRefConflict(undefined)).toBe(false);
  });
});
