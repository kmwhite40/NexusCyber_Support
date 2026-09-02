// isFieldVisible is a hand-maintained mirror of the server's implementation in
// apps/api/src/modules/form-fields.ts (re-exported by apps/api/src/modules/forms.ts).
// Historically the only thing keeping the two in sync was a comment. apps/api's
// form-visibility-parity.test.ts now pins the two function *bodies* to each other
// character-for-character, and separately runs the shared fixture table below against
// the server copy — but until apps/web had a test runner, that table could never be
// executed against what actually ships to the browser.
//
// This file closes that gap: it imports the SAME fixture table (single source of
// truth — not a duplicated copy that could itself drift) and runs it directly against
// the client's isFieldVisible. Any future edit to either implementation that changes
// behaviour now fails a test in the workspace it was made in, not just the other one.
import { describe, it, expect } from 'vitest';
import { isFieldVisible } from '@/components/dynamic-form-field';
import type { FormFieldDef, VisibleWhen } from '@/lib/api';
import { VISIBILITY_CASES } from '../../api/test/fixtures/form-visibility-cases';

function field(visible_when: VisibleWhen | null): FormFieldDef {
  return {
    key: 'target',
    label: 'Target',
    data_type: 'text',
    required: false,
    options: [],
    visible_when,
    sensitive: false,
    options_source: null,
  };
}

describe('isFieldVisible — shared fixture table (client)', () => {
  for (const c of VISIBILITY_CASES) {
    it(c.name, () => {
      expect(isFieldVisible(field(c.visible_when as VisibleWhen | null), c.answers)).toBe(c.expected);
    });
  }
});
