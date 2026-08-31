import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

/**
 * Every ``EXPO_PUBLIC_*`` value the web build cannot supply a default for has
 * to be declared in ``frontend/Dockerfile``.
 *
 * A Docker build sees none of the host's service variables unless the
 * Dockerfile names them, and ``expo export`` bakes whatever it can see into
 * the bundle at build time. An undeclared variable therefore produces a green
 * deploy with a silently missing feature and nothing in any log — the exact
 * failure the Google client ID and the Sentry DSN were each fixed for. This
 * test is the thing that notices the fourth time.
 *
 * Variables carrying a safe in-code default (the Gumroad links) are outside
 * this list by design. They ARE declared in the Dockerfile — an override has to
 * be able to reach the bundle — but their absence is survivable, so they belong
 * to the parity check above rather than to this list, whose members resolve to
 * nothing at all when undeclared.
 *
 * "Safe default" is a claim about the value, not just its presence: the Gumroad
 * product URL sat here for months naming a storefront that did not exist, and
 * every visitor who pressed Get Started reached a 404. The default is pinned by
 * exact value in ``config.test.ts`` for that reason.
 */

const DOCKERFILE = readFileSync(join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

/** The build-time values that resolve to nothing at all when undeclared. */
const NO_DEFAULT_VARIABLES: readonly string[] = [
  'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB',
  'EXPO_PUBLIC_SENTRY_DSN',
  'EXPO_PUBLIC_SANGHA_INVITE_URL',
];

describe('frontend Dockerfile build arguments', () => {
  it.each(NO_DEFAULT_VARIABLES)('declares ARG %s', (name) => {
    expect(DOCKERFILE).toContain(`ARG ${name}\n`);
  });

  it.each(NO_DEFAULT_VARIABLES)('forwards %s into the build environment', (name) => {
    // ARG alone is invisible to `expo export`; only the ENV line reaches it.
    expect(DOCKERFILE).toContain(`ENV ${name}=$${name}`);
  });

  it('declares every variable before the export that bakes them in', () => {
    // The `RUN` prefix matters: the prose above it names `expo export` too,
    // and matching the comment would compare against the wrong offset.
    const exportAt = DOCKERFILE.indexOf('RUN npx expo export');

    expect(exportAt).toBeGreaterThan(-1);
    for (const name of NO_DEFAULT_VARIABLES) {
      expect(DOCKERFILE.indexOf(`ENV ${name}=`)).toBeLessThan(exportAt);
    }
  });
});
