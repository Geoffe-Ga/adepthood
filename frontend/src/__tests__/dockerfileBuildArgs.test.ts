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
 * Variables carrying a safe in-code default (the Gumroad links) live in a
 * second list, ``SAFE_DEFAULT_VARIABLES``. They must still be declared — an
 * override has to be able to reach the bundle at all — but an undeclared one
 * degrades to a working default rather than to nothing, so the two groups are
 * kept apart by consequence rather than lumped together.
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

/**
 * Build-time values that carry a safe in-code default.
 *
 * Undeclared, these do not break the page -- ``resolveEnv`` falls through to
 * the default -- but the override silently stops working, which is how a
 * deploy-time variable comes to be believed in without ever taking effect.
 * They were genuinely undeclared until the Gumroad storefront went live and
 * the default turned out to name a 404.
 */
const SAFE_DEFAULT_VARIABLES: readonly string[] = [
  'EXPO_PUBLIC_GUMROAD_PRODUCT_URL',
  'EXPO_PUBLIC_GUMROAD_HELP_URL',
];

const ALL_DECLARED_VARIABLES: readonly string[] = [
  ...NO_DEFAULT_VARIABLES,
  ...SAFE_DEFAULT_VARIABLES,
];

describe('frontend Dockerfile build arguments', () => {
  it.each(NO_DEFAULT_VARIABLES)('declares ARG %s', (name) => {
    expect(DOCKERFILE).toContain(`ARG ${name}\n`);
  });

  it.each(NO_DEFAULT_VARIABLES)('forwards %s into the build environment', (name) => {
    // ARG alone is invisible to `expo export`; only the ENV line reaches it.
    expect(DOCKERFILE).toContain(`ENV ${name}=$${name}`);
  });

  it.each(SAFE_DEFAULT_VARIABLES)('declares ARG %s', (name) => {
    // Without this the Railway variable never reaches `expo export` and the
    // override is inert -- the failure this file exists to prevent, in its
    // quieter form: the page still works, but only ever on the default.
    expect(DOCKERFILE).toContain(`ARG ${name}\n`);
  });

  it.each(SAFE_DEFAULT_VARIABLES)('forwards %s into the build environment', (name) => {
    expect(DOCKERFILE).toContain(`ENV ${name}=$${name}`);
  });

  it('declares every variable before the export that bakes them in', () => {
    // The `RUN` prefix matters: the prose above it names `expo export` too,
    // and matching the comment would compare against the wrong offset.
    const exportAt = DOCKERFILE.indexOf('RUN npx expo export');

    expect(exportAt).toBeGreaterThan(-1);
    for (const name of ALL_DECLARED_VARIABLES) {
      expect(DOCKERFILE.indexOf(`ENV ${name}=`)).toBeLessThan(exportAt);
    }
  });
});
