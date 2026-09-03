/**
 * Which build is answering.
 *
 * scripts/deploy-api.sh used to poll /readyz until it returned 200 and call that success — but
 * during an App Service container swap the OLD container answers that poll, so a 200 says
 * nothing about the image just deployed. That is not hypothetical: a deploy printed ✓ while the
 * new container had not yet booted, and had its migrations failed it would have printed ✓ against
 * a healthy old container with a crash-looping new one behind it.
 *
 * Baked in at image build time from the git SHA the deploy script already uses as the ACR tag.
 * Only the commit is exposed: /healthz is unauthenticated, and that value is already public in
 * the tag and in the deploy output, so it leaks nothing new. Nothing else belongs here.
 */
export function buildInfo(env: NodeJS.ProcessEnv | Record<string, string | undefined>): { build: string } {
  // 'unknown' rather than a throw: local dev and the test suite run with no build arg, and an
  // endpoint that 500s because a build arg was missing would be a worse failure than the one
  // this exists to prevent.
  return { build: (env.BUILD_SHA ?? '').trim() || 'unknown' };
}
