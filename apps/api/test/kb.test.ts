import { describe, it, expect } from 'vitest';
import { canTransition, buildPageTree } from '../src/modules/kb.js';

describe('canTransition (KB page lifecycle)', () => {
  it('allows draft -> published and draft -> archived', () => {
    expect(canTransition('draft', 'published')).toBe(true);
    expect(canTransition('draft', 'archived')).toBe(true);
  });
  it('allows published -> archived and published -> draft (unpublish)', () => {
    expect(canTransition('published', 'archived')).toBe(true);
    expect(canTransition('published', 'draft')).toBe(true);
  });
  it('allows archived -> draft (restore) but not archived -> published directly', () => {
    expect(canTransition('archived', 'draft')).toBe(true);
    expect(canTransition('archived', 'published')).toBe(false);
  });
  it('rejects no-op transitions', () => {
    expect(canTransition('draft', 'draft')).toBe(false);
  });
});

describe('buildPageTree', () => {
  it('nests children under parents and keeps roots at the top', () => {
    const pages = [
      { id: 'a', parent_id: null, title: 'Root A' },
      { id: 'b', parent_id: 'a', title: 'Child of A' },
      { id: 'c', parent_id: 'b', title: 'Grandchild' },
      { id: 'd', parent_id: null, title: 'Root D' },
    ];
    const tree = buildPageTree(pages);
    expect(tree.map((n) => n.id)).toEqual(['a', 'd']);
    expect(tree[0].children.map((n: any) => n.id)).toEqual(['b']);
    expect(tree[0].children[0].children.map((n: any) => n.id)).toEqual(['c']);
  });
  it('treats a missing parent as a root (orphan-safe)', () => {
    const tree = buildPageTree([{ id: 'x', parent_id: 'gone', title: 'Orphan' }]);
    expect(tree.map((n) => n.id)).toEqual(['x']);
  });
});
