// Sign-in lands where a signed-out visitor was headed — e.g. the change linked from a CAB
// vote-request email — instead of always on the home page.
import { describe, it, expect, beforeEach } from 'vitest';
import { rememberReturnPath, takeReturnPath, markSignedOut } from '@/lib/api';

describe('return path after sign-in', () => {
  beforeEach(() => sessionStorage.clear());

  it('returns the remembered path once', () => {
    rememberReturnPath('/changes?change=c-42');
    expect(takeReturnPath()).toBe('/changes?change=c-42');
    expect(takeReturnPath()).toBeNull();
  });

  it.each(['//evil.example/x', 'https://evil.example/x', '/\\evil.example', 'changes'])(
    'refuses %s — only same-site paths, never an open redirect',
    (bad) => {
      rememberReturnPath(bad);
      expect(takeReturnPath()).toBeNull();
    },
  );

  it('does not remember the page someone signed out from', () => {
    markSignedOut();
    rememberReturnPath('/tickets/t-1');
    expect(takeReturnPath()).toBeNull();
    // …but only that once: the next signed-out visit is remembered again.
    rememberReturnPath('/changes?change=c-42');
    expect(takeReturnPath()).toBe('/changes?change=c-42');
  });
});
