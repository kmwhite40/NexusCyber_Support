// Shared fixture table pinning `isFieldVisible` behaviour. TWO implementations must agree:
//   - apps/api/src/modules/form-fields.ts  (server; decides what is validated and persisted)
//   - apps/web/components/dynamic-form-field.tsx (client; decides what is rendered/submitted)
// A drift between them is silent and dangerous in both directions: a field the client hides
// but the server persists smuggles unvalidated data in; a field the server hides but the
// client shows makes a required answer vanish. `form-visibility-parity.test.ts` runs this
// table against the server implementation and, separately, pins the two function bodies to
// each other character-for-character.
//
// The option strings are the ones actually seeded by migration 0054 — a fixture using
// invented strings would pass while masking the exact failure mode it exists to catch.

export interface VisibilityCase {
  name: string;
  visible_when: { field: string; equals: string } | { field: string; in: string[] } | null;
  answers: Record<string, unknown>;
  expected: boolean;
}

export const VISIBILITY_CASES: VisibilityCase[] = [
  { name: 'no condition is always visible', visible_when: null, answers: {}, expected: true },
  {
    name: 'equals: matching value shows the field',
    visible_when: { field: 'access_type', equals: 'Temporary' },
    answers: { access_type: 'Temporary' }, expected: true,
  },
  {
    name: 'equals: non-matching value hides the field',
    visible_when: { field: 'access_type', equals: 'Temporary' },
    answers: { access_type: 'Permanent' }, expected: false,
  },
  {
    name: 'equals: absent controlling answer hides the field',
    visible_when: { field: 'access_type', equals: 'Temporary' },
    answers: {}, expected: false,
  },
  {
    name: 'equals is case-sensitive and exact (no trimming)',
    visible_when: { field: 'access_type', equals: 'Temporary' },
    answers: { access_type: 'temporary' }, expected: false,
  },
  {
    name: 'in: first seeded WFH option shows the field',
    visible_when: { field: 'work_location', in: ['Work from Home - Permanent', 'Work from Home - Temporary'] },
    answers: { work_location: 'Work from Home - Permanent' }, expected: true,
  },
  {
    name: 'in: second seeded WFH option shows the field',
    visible_when: { field: 'work_location', in: ['Work from Home - Permanent', 'Work from Home - Temporary'] },
    answers: { work_location: 'Work from Home - Temporary' }, expected: true,
  },
  {
    name: 'in: On Site hides the home-address fields',
    visible_when: { field: 'work_location', in: ['Work from Home - Permanent', 'Work from Home - Temporary'] },
    answers: { work_location: 'On Site' }, expected: false,
  },
  {
    name: 'in: a stale/abbreviated option string does NOT match (the silent-hide failure mode)',
    visible_when: { field: 'work_location', in: ['Work from Home - Permanent', 'Work from Home - Temporary'] },
    answers: { work_location: 'WFH-Permanent' }, expected: false,
  },
  {
    name: 'in: empty option list never matches',
    visible_when: { field: 'work_location', in: [] },
    answers: { work_location: 'On Site' }, expected: false,
  },
  {
    name: 'non-string controlling answer (boolean) hides the field',
    visible_when: { field: 'request_kind', equals: 'Replacement' },
    answers: { request_kind: true }, expected: false,
  },
  {
    name: 'non-string controlling answer (array) hides the field',
    visible_when: { field: 'work_location', in: ['On Site'] },
    answers: { work_location: ['On Site'] }, expected: false,
  },
  {
    name: 'null controlling answer hides the field',
    visible_when: { field: 'request_kind', equals: 'Replacement' },
    answers: { request_kind: null }, expected: false,
  },
  {
    name: 'empty-string controlling answer hides the field',
    visible_when: { field: 'request_kind', equals: 'Replacement' },
    answers: { request_kind: '' }, expected: false,
  },
  {
    name: 'equals: Replacement reveals replacement_for',
    visible_when: { field: 'request_kind', equals: 'Replacement' },
    answers: { request_kind: 'Replacement' }, expected: true,
  },
  {
    name: 'equals: New Hire hides replacement_for',
    visible_when: { field: 'request_kind', equals: 'Replacement' },
    answers: { request_kind: 'New Hire' }, expected: false,
  },
];
