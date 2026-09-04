import { describe, it, expect, vi } from 'vitest';
import { formatLifetime } from '../src/modules/provisioning/index.js';
import { issueTap } from '../src/integrations/m365/provisioning-graph.js';

// The pass lifetime and the sentence describing it in the handover email were hardcoded in two
// different files: `lifetimeInMinutes: 480` in the Graph call, "expires in 8 hours" in the copy.
// Changing one silently made the other lie — to the one person who has to explain the pass to a
// new starter.
describe('formatLifetime', () => {
  it('reads naturally at the values anyone would configure', () => {
    expect(formatLifetime(60)).toBe('1 hour');
    expect(formatLifetime(480)).toBe('8 hours');
    expect(formatLifetime(1440)).toBe('1 day');
    expect(formatLifetime(10080)).toBe('7 days');
  });

  it('does not round away an odd value into a lie', () => {
    // 90 minutes is not "1 hour". A pass that expires sooner than the email claims is the
    // failure mode that matters: the new starter tries it and it is already dead.
    expect(formatLifetime(90)).toBe('90 minutes');
    expect(formatLifetime(500)).toBe('500 minutes');
  });
});

describe('issueTap', () => {
  it('sends the configured lifetime rather than a hardcoded one', async () => {
    const posted: any[] = [];
    const g = { post: vi.fn(async (_u: string, b: unknown) => { posted.push(b); return {}; }) } as any;
    await issueTap(g, 'user-1', 10080);
    expect(posted[0]).toEqual({ isUsableOnce: true, lifetimeInMinutes: 10080 });
  });
});
