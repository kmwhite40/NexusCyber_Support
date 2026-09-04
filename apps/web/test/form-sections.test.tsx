import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { groupFieldsBySection } from '@/components/dynamic-form-field';
import type { FormFieldDef } from '@/lib/api';

const f = (key: string, section: string | null): FormFieldDef => ({
  key, label: key, data_type: 'text', required: false, options: [],
  visible_when: null, sensitive: false, options_source: null, section,
} as FormFieldDef);

// The onboarding intake is 34 fields in one dialog. Headings only help if each one appears once:
// grouping that lets a section repeat as the list jumps between them is worse than no grouping.
describe('groupFieldsBySection', () => {
  it('keeps each section to a single run, in field order', () => {
    const groups = groupFieldsBySection([
      f('a', 'The person'), f('b', 'The person'), f('c', 'The role'), f('d', 'The role'),
    ]);
    expect(groups.map((g) => g.section)).toEqual(['The person', 'The role']);
    expect(groups[0].fields.map((x) => x.key)).toEqual(['a', 'b']);
  });

  // Short forms are worse with headings than without, and most forms have no sections at all.
  it('returns one unnamed group when nothing is sectioned', () => {
    const groups = groupFieldsBySection([f('a', null), f('b', null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].section).toBeNull();
    expect(groups[0].fields).toHaveLength(2);
  });

  // A form that is only partly sectioned must not silently drop the rest.
  it('keeps ungrouped fields rather than losing them', () => {
    const groups = groupFieldsBySection([f('a', null), f('b', 'The role'), f('c', null)]);
    expect(groups.flatMap((g) => g.fields.map((x) => x.key)).sort()).toEqual(['a', 'b', 'c']);
  });

  // Defensive: if a form ever interleaves sections, render the runs as they come rather than
  // reordering someone's form behind their back.
  it('does not merge or reorder an interleaved form', () => {
    const groups = groupFieldsBySection([f('a', 'X'), f('b', 'Y'), f('c', 'X')]);
    expect(groups.map((g) => g.section)).toEqual(['X', 'Y', 'X']);
  });
});
