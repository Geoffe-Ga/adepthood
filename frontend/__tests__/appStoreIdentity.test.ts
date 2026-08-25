import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

/**
 * The store identity declared in `app.json`, and its agreement with the code.
 *
 * Every field checked here is read by Expo when it produces a binary, and two
 * of them are the app's public name in a store listing. They were left at the
 * `create-expo-app` scaffold defaults (`"frontend"`, no bundle identifier, no
 * package, no scheme) long enough that nothing noticed the app could not be
 * built for either store.
 *
 * A test that only asserted "the fields are non-empty" would go green on a
 * typo. What actually breaks silently is *disagreement*: the app already ships
 * `adepthood://` deep links in `App.tsx` and in the practice share sheet, and
 * those resolve to nothing at all unless `app.json` registers the same scheme.
 * So the load-bearing assertions below compare the manifest against the code
 * that depends on it rather than against a literal spelled twice.
 *
 * The EAS `projectId` is deliberately *not* required. It is issued by Expo
 * against a real account (`eas init`) and cannot be invented; a fabricated UUID
 * would look configured and fail at build time, which is strictly worse than
 * absent. The rule enforced here is "absent, or genuinely issued" — never a
 * placeholder.
 */

const FRONTEND_ROOT = resolve(__dirname, '..');

/** The `create-expo-app` scaffold default, and the value being replaced. */
const SCAFFOLD_DEFAULT_NAME = 'frontend';

/** Expo slugs travel in URLs: lowercase alphanumerics joined by single hyphens. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Apple allows alphanumerics, hyphens and periods in a bundle identifier. */
const BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/;

/**
 * An Android package is a Java package name: at least two segments, each
 * starting with a letter, and — unlike Apple — no hyphens anywhere.
 */
const ANDROID_PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/** A URI scheme per RFC 3986, restricted to lowercase so the two stores agree. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

/** EAS issues project ids as canonical UUIDs; anything else is a placeholder. */
const EAS_PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ExpoManifest {
  expo?: {
    name?: string;
    slug?: string;
    scheme?: string;
    ios?: { bundleIdentifier?: string; usesAppleSignIn?: boolean };
    android?: { package?: string };
    extra?: { eas?: { projectId?: string } };
  };
}

/** Read a repo file relative to `frontend/`. */
function readFrontendFile(...segments: string[]): string {
  return readFileSync(resolve(FRONTEND_ROOT, ...segments), 'utf-8');
}

const manifest = JSON.parse(readFrontendFile('app.json')) as ExpoManifest;
const expo = manifest.expo ?? {};

/** Pull the scheme out of the first `<scheme>://` literal in a source file. */
function declaredScheme(source: string, pattern: RegExp): string | null {
  return source.match(pattern)?.[1] ?? null;
}

const APP_TSX = readFrontendFile('src', 'App.tsx');
const SHARE_SHEET = readFrontendFile('src', 'features', 'Practice', 'components', 'ShareSheet.tsx');

const NAVIGATION_SCHEME = declaredScheme(APP_TSX, /prefixes:\s*\[\s*'([a-z0-9+.-]+):\/\//);
const SHARE_LINK_SCHEME = declaredScheme(
  SHARE_SHEET,
  /DEEP_LINK_PREFIX\s*=\s*'([a-z0-9+.-]+):\/\//,
);

describe('app.json store identity', () => {
  it('gives the app a display name that is not the scaffold default', () => {
    expect(expo.name).not.toBe(SCAFFOLD_DEFAULT_NAME);
    expect(expo.name ?? '').not.toHaveLength(0);
  });

  it('gives the app a slug that is not the scaffold default', () => {
    expect(expo.slug).not.toBe(SCAFFOLD_DEFAULT_NAME);
    expect(expo.slug ?? '').toMatch(SLUG_PATTERN);
  });

  it('declares an iOS bundle identifier in reverse-DNS form', () => {
    expect(expo.ios?.bundleIdentifier ?? '').toMatch(BUNDLE_IDENTIFIER_PATTERN);
  });

  it('declares an Android package in reverse-DNS form', () => {
    expect(expo.android?.package ?? '').toMatch(ANDROID_PACKAGE_PATTERN);
  });

  it('uses one identifier across both stores', () => {
    expect(expo.ios?.bundleIdentifier).toBe(expo.android?.package);
  });

  // `usesAppleSignIn` provisions the Sign in with Apple entitlement, which is
  // keyed to the bundle identifier. Set without one, it fails the build outright
  // rather than degrading to a missing button.
  it('does not enable Sign in with Apple without a bundle identifier', () => {
    if (expo.ios?.usesAppleSignIn !== true) return;
    expect(expo.ios.bundleIdentifier ?? '').toMatch(BUNDLE_IDENTIFIER_PATTERN);
  });
});

describe('app.json deep-link scheme', () => {
  it('registers a URI scheme', () => {
    expect(expo.scheme ?? '').toMatch(SCHEME_PATTERN);
  });

  it('matches the scheme the root navigator already links against', () => {
    expect(NAVIGATION_SCHEME).not.toBeNull();
    expect(expo.scheme).toBe(NAVIGATION_SCHEME);
  });

  it('matches the scheme the practice share sheet already hands out', () => {
    expect(SHARE_LINK_SCHEME).not.toBeNull();
    expect(expo.scheme).toBe(SHARE_LINK_SCHEME);
  });
});

describe('EAS project id', () => {
  const projectId = expo.extra?.eas?.projectId;

  // Owner-only: `eas init` mints this against a real Expo account. Absent is a
  // known, honest gap; a stand-in string is a build failure wearing a costume.
  it('is either absent or a UUID issued by EAS', () => {
    if (projectId === undefined) return;
    expect(projectId).toMatch(EAS_PROJECT_ID_PATTERN);
  });

  it.each(['', 'TODO', 'your-project-id', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'])(
    'rejects the placeholder %p',
    (placeholder) => {
      expect(placeholder).not.toMatch(EAS_PROJECT_ID_PATTERN);
    },
  );

  it('accepts a canonical UUID', () => {
    expect('3f1c9a2e-4b7d-4c6a-9e21-8d5f0b7a1c34').toMatch(EAS_PROJECT_ID_PATTERN);
  });
});
