import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isFieldVisible, type FormField } from '../src/modules/forms.js';
import { VISIBILITY_CASES } from './fixtures/form-visibility-cases.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const field = (visible_when: FormField['visible_when']): FormField => ({
  key: 'target', label: 'Target', data_type: 'text', required: false, options: [],
  maps_to: null, visible_when, sensitive: false, options_source: null,
});

describe('isFieldVisible — shared fixture table (server)', () => {
  for (const c of VISIBILITY_CASES) {
    it(c.name, () => {
      expect(isFieldVisible(field(c.visible_when as FormField['visible_when']), c.answers)).toBe(c.expected);
    });
  }
});

/**
 * Client/server parity. apps/web has no test runner (its only script is `typecheck`), so the
 * fixture table above cannot be executed against the browser copy from here. Instead we pin
 * the two implementations to each other by SOURCE: both function bodies are plain JS with no
 * type annotations, so a character-for-character comparison of the normalized bodies fails
 * the moment either side is edited without the other. That is the drift this catches.
 */
function bodyOf(source: string): string {
  const start = source.indexOf('export function isFieldVisible');
  expect(start, 'isFieldVisible not found in source').toBeGreaterThan(-1);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  let i = open;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) break;
  }
  return source.slice(open + 1, i).replace(/\s+/g, ' ').trim();
}

describe('isFieldVisible — client/server parity', () => {
  it('the web copy is character-for-character the server implementation', () => {
    const server = readFileSync(join(repoRoot, 'apps/api/src/modules/form-fields.ts'), 'utf8');
    const client = readFileSync(join(repoRoot, 'apps/web/components/dynamic-form-field.tsx'), 'utf8');
    const serverBody = bodyOf(server);
    expect(serverBody).toContain('visible_when');
    expect(bodyOf(client)).toBe(serverBody);
  });
});
