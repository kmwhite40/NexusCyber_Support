import { describe, it, expect } from 'vitest';
import { buildInfo } from '../src/build-info.js';

// deploy-api.sh polls /readyz until it returns 200 — but during an App Service container swap
// the OLD container answers that poll, so a 200 proves nothing about the image just deployed.
// Observed for real: the script printed ✓ while the new container had not booted. Had a
// migration failed, it would have printed ✓ against a healthy old container crash-looping behind
// it. /healthz now reports which build is answering, so the deploy can verify the thing it
// actually cares about instead of a proxy for it.
describe('buildInfo', () => {
  it('reports the commit baked in at build time', () => {
    expect(buildInfo({ BUILD_SHA: 'abc1234' }).build).toBe('abc1234');
  });

  it('reports "unknown" rather than throwing when the env var is absent', () => {
    // Local dev and tests run without it. An endpoint that 500s because a build arg was not
    // passed would be a worse failure than the one this exists to fix.
    expect(buildInfo({}).build).toBe('unknown');
  });

  it('trims whitespace, since the value arrives from a shell substitution', () => {
    expect(buildInfo({ BUILD_SHA: '  abc1234\n' }).build).toBe('abc1234');
  });

  it('exposes only the commit — no branch, no build host, no paths', () => {
    // /healthz is unauthenticated. The SHA is already public in the ACR tag and the deploy
    // output; nothing else should join it.
    expect(Object.keys(buildInfo({ BUILD_SHA: 'abc1234' }))).toEqual(['build']);
  });
});
