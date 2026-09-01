// Form-field shape and the visibility predicate, in a leaf module that both `forms.ts`
// and `sensitive-fields.ts` import one-way. Previously these lived in `forms.ts`, which
// imported `sensitive-fields.ts` while `sensitive-fields.ts` imported back — a cycle that
// was inert only because every use was inside a function body. This module removes it.
//
// The public import paths are unchanged: `forms.ts` re-exports everything here.

export type FieldType =
  | 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date'
  | 'user' | 'user_multi' | 'attachment'
  | 'email' | 'phone';

export type VisibleWhen = { field: string; equals: string } | { field: string; in: string[] };

export interface FormField {
  key: string;
  label: string;
  data_type: FieldType;
  required: boolean;
  options: string[];
  maps_to: string | null;
  visible_when: VisibleWhen | null;
  sensitive: boolean;
  options_source: string | null;
}

/** Is this field shown, given the current answers? Fields with no condition are always shown.
 *  MUST behave identically to the client copy in apps/web/components/dynamic-form-field.tsx;
 *  apps/api/test/form-visibility-parity.test.ts pins the two bodies to each other. */
export function isFieldVisible(field: FormField, answers: Record<string, unknown>): boolean {
  const cond = field.visible_when;
  if (!cond) return true;
  const actual = answers[cond.field];
  if (typeof actual !== 'string') return false;
  return 'equals' in cond ? actual === cond.equals : cond.in.includes(actual);
}
