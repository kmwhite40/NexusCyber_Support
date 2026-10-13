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
  it('reports status and tenantId as ignored rather than dropping them', () => {
    const { ignored } = parseIntegrationTicket(
      payload({ status: 'open', priority: 'P0', tenantId: null }),
    );
    // `priority` is deliberately absent: since phase D it is APPLIED, stored verbatim as the
    // caller's own ordering in external_priority rather than discarded.
    expect(ignored.sort()).toEqual(['status', 'tenantId']);
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

  it('now accepts parentExternalRef, which phase D promoted out of the refused tier', () => {
    const { input } = parseIntegrationTicket(payload({ parentExternalRef: 'carbon-conmon:backlog:WS-1' }));
    expect(input.integration?.parentExternalRef).toBe('carbon-conmon:backlog:WS-1');
  });

  it('still refuses a genuinely unknown field, so the refusal path has not rotted', () => {
    const e = (() => {
      try { parseIntegrationTicket(payload({ storyPoints: 5 })); } catch (err) { return err as ApiError; }
    })();
    expect(e?.status).toBe(422);
    expect(e?.errors?.map((x) => x.field)).toContain('storyPoints');
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

// ---- Fixes from the whole-branch review ----

describe('parseIntegrationTicket — severity presence (review Important 1)', () => {
  it('emits no impact/urgency when severity is absent, so an upsert cannot downgrade priority', () => {
    const { input } = parseIntegrationTicket(payload({ owner: 'A' }));
    expect(input.impact).toBeUndefined();
    expect(input.urgency).toBeUndefined();
  });

  it('still emits impact/urgency when severity is sent', () => {
    const { input } = parseIntegrationTicket(payload({ severity: 'critical' }));
    expect(input.impact).toBe(1);
    expect(input.urgency).toBe(1);
  });

  it('emits 3/3 for an explicit null severity, which is a stated value not an omission', () => {
    const { input } = parseIntegrationTicket(payload({ severity: null }));
    expect(input.impact).toBe(3);
    expect(input.urgency).toBe(3);
  });
});

describe('parseIntegrationTicket — null on every optional field (review Important 2)', () => {
  it('accepts null for description, labels, metadata and status like its siblings', () => {
    expect(() =>
      parseIntegrationTicket(
        payload({ description: null, labels: null, metadata: null, status: null }),
      ),
    ).not.toThrow();
  });

  it('treats a null description as unset, so an upsert preserves the stored one', () => {
    const { input } = parseIntegrationTicket(payload({ description: null }));
    expect(input.description).toBeUndefined();
  });

  it('treats null labels and metadata as unset rather than as a wipe', () => {
    const { input } = parseIntegrationTicket(payload({ labels: null, metadata: null }));
    expect(input.tags).toBeUndefined();
    expect(input.customFields).toBeUndefined();
  });

  it('still reports a null status in ignored[]', () => {
    expect(parseIntegrationTicket(payload({ status: null })).ignored).toContain('status');
  });
});

describe('parseIntegrationTicket — non-operational sources carry no SLA clock', () => {
  it('suppresses the clock for source "backlog"', () => {
    const { input } = parseIntegrationTicket(payload({ source: 'backlog' }));
    expect(input.integration?.suppressSla).toBe(true);
  });

  it('leaves the clock running for a remediation source', () => {
    for (const source of ['poam', 'risk', 'conmon-poam', 'conmon-risk']) {
      const { input } = parseIntegrationTicket(payload({ source }));
      expect(input.integration?.suppressSla).toBeFalsy();
    }
  });

  it('does not treat a source merely containing "backlog" as non-operational', () => {
    const { input } = parseIntegrationTicket(payload({ source: 'backlog-review' }));
    expect(input.integration?.suppressSla).toBeFalsy();
  });
});

// ---- Phase D: backlog fields ----

describe('parseIntegrationTicket — backlog fields are accepted, not refused', () => {
  const backlog = (over: Record<string, unknown> = {}) =>
    payload({ source: 'backlog', externalRef: 'carbon-conmon:backlog:WS-1.1', ...over });

  it('maps every phase-D field onto the integration group', () => {
    const { input } = parseIntegrationTicket(
      backlog({
        parentExternalRef: 'carbon-conmon:backlog:WS-1',
        estimateDays: 3.5,
        phase: 2,
        workstream: 'WS-1',
        acceptanceCriteria: 'The reconciler converges after a dropped webhook.',
        priority: 'P0',
      }),
    );
    expect(input.integration).toMatchObject({
      parentExternalRef: 'carbon-conmon:backlog:WS-1',
      estimateDays: 3.5,
      workPhase: '2',
      workstream: 'WS-1',
      acceptanceCriteria: 'The reconciler converges after a dropped webhook.',
      externalPriority: 'P0',
    });
  });

  it('accepts post-mvp as a phase alongside the numeric ones', () => {
    expect(parseIntegrationTicket(backlog({ phase: 'post-mvp' })).input.integration?.workPhase).toBe('post-mvp');
    expect(parseIntegrationTicket(backlog({ phase: 1 })).input.integration?.workPhase).toBe('1');
  });

  it('refuses a phase outside the known set', () => {
    const e = (() => { try { parseIntegrationTicket(backlog({ phase: 7 })); } catch (err) { return err as ApiError; } })();
    expect(e?.status).toBe(422);
    expect(e?.errors?.map((x) => x.field)).toContain('phase');
  });

  it('refuses a negative estimate', () => {
    const e = (() => { try { parseIntegrationTicket(backlog({ estimateDays: -1 })); } catch (err) { return err as ApiError; } })();
    expect(e?.status).toBe(422);
  });

  it('no longer reports priority as ignored — it is stored as the caller own ordering', () => {
    const { ignored, input } = parseIntegrationTicket(backlog({ priority: 'P1' }));
    expect(ignored).not.toContain('priority');
    expect(input.integration?.externalPriority).toBe('P1');
  });

  it('keeps Anchor derived priority separate from the caller priority', () => {
    const { input } = parseIntegrationTicket(backlog({ priority: 'P0', severity: 'low' }));
    expect(input.integration?.externalPriority).toBe('P0');
    expect(input.impact).toBe(4); // from severity low, not from P0
  });
});

describe('parseIntegrationTicket — blocked items', () => {
  const backlog = (over: Record<string, unknown> = {}) =>
    payload({ source: 'backlog', externalRef: 'carbon-conmon:backlog:WS-2.1', ...over });

  it('creates as blocked when a blockedReason is given', () => {
    const { input } = parseIntegrationTicket(backlog({ blockedReason: 'Waiting on the Anchor contract' }));
    expect(input.integration?.blockedReason).toBe('Waiting on the Anchor contract');
    expect(input.initialStatus).toBe('blocked');
  });

  it('refuses status blocked without a reason, naming the missing field', () => {
    const e = (() => {
      try { parseIntegrationTicket(backlog({ status: 'blocked' })); } catch (err) { return err as ApiError; }
    })();
    expect(e?.status).toBe(422);
    expect(e?.errors?.map((x) => x.field)).toContain('blockedReason');
  });

  it('leaves an unblocked item with no initial status override', () => {
    expect(parseIntegrationTicket(backlog()).input.initialStatus).toBeUndefined();
  });
});
