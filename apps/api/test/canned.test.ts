import { describe, it, expect } from 'vitest';
import { applyPlaceholders } from '../src/modules/canned.js';

describe('applyPlaceholders', () => {
  it('substitutes known tokens', () => {
    expect(applyPlaceholders('Hi {{requester_name}}, ticket {{ticket_number}} is resolved.', { requester_name: 'Alex', ticket_number: 'ACME-1' }))
      .toBe('Hi Alex, ticket ACME-1 is resolved.');
  });
  it('tolerates surrounding whitespace in tokens', () => {
    expect(applyPlaceholders('Hello {{ name }}', { name: 'Sam' })).toBe('Hello Sam');
  });
  it('leaves unknown tokens intact', () => {
    expect(applyPlaceholders('Hi {{missing}}', {})).toBe('Hi {{missing}}');
  });
  it('handles a body with no tokens', () => {
    expect(applyPlaceholders('Plain text', { a: '1' })).toBe('Plain text');
  });
});
