/* eslint-env jest */
/* global describe, it, expect, afterEach, jest */

const IOS_ENV = 'EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS';
const ANDROID_ENV = 'EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID';
const WEB_ENV = 'EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB';

const IOS_ID = '1000-ios.apps.googleusercontent.com';
const ANDROID_ID = '2000-android.apps.googleusercontent.com';
const WEB_ID = '3000-web.apps.googleusercontent.com';

interface OAuthConfigModule {
  googleClientIds: { ios: string; android: string; web: string };
  isGoogleAuthConfigured: () => boolean;
}

const ORIGINAL_ENV = { ...process.env };

/**
 * Re-evaluate ``oauthConfig`` against a specific ``Platform.OS`` and a specific
 * set of ``EXPO_PUBLIC_*`` values. The client IDs are read once at import time,
 * so every permutation needs a fresh module registry — and ``react-native`` has
 * to be required from that same fresh registry, otherwise the ``Platform``
 * object we patch is not the one ``oauthConfig`` sees.
 */
function loadOauthConfig(os: string, env: Record<string, string>): OAuthConfigModule {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env[IOS_ENV];
  delete process.env[ANDROID_ENV];
  delete process.env[WEB_ENV];
  Object.assign(process.env, env);

  const reactNative = require('react-native') as { Platform: { OS: string } };
  Object.defineProperty(reactNative.Platform, 'OS', { configurable: true, get: () => os });

  return require('../oauthConfig') as OAuthConfigModule;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

describe('googleClientIds', () => {
  it('reads each platform client ID from its own EXPO_PUBLIC variable', () => {
    const config = loadOauthConfig('ios', {
      [IOS_ENV]: IOS_ID,
      [ANDROID_ENV]: ANDROID_ID,
      [WEB_ENV]: WEB_ID,
    });

    expect(config.googleClientIds).toEqual({ ios: IOS_ID, android: ANDROID_ID, web: WEB_ID });
  });

  it('defaults every client ID to the empty string when nothing is configured', () => {
    const config = loadOauthConfig('ios', {});

    expect(config.googleClientIds).toEqual({ ios: '', android: '', web: '' });
  });
});

describe('isGoogleAuthConfigured', () => {
  it.each([
    ['ios', IOS_ENV, IOS_ID],
    ['android', ANDROID_ENV, ANDROID_ID],
    ['web', WEB_ENV, WEB_ID],
  ])('is true on %s when only that platform ID is set', (os, envName, value) => {
    const config = loadOauthConfig(os, { [envName]: value });

    expect(config.isGoogleAuthConfigured()).toBe(true);
  });

  it.each([
    ['ios', WEB_ENV],
    ['android', WEB_ENV],
    ['web', IOS_ENV],
  ])('is false on %s when only another platform ID is set', (os, otherEnvName) => {
    const config = loadOauthConfig(os, { [otherEnvName]: WEB_ID });

    expect(config.isGoogleAuthConfigured()).toBe(false);
  });

  // Anything that is neither iOS nor Android runs the browser redirect flow,
  // so an unrecognised OS must resolve to the web client ID rather than
  // silently disabling sign-in.
  it('falls back to the web client ID on an OS that is neither ios nor android', () => {
    const config = loadOauthConfig('macos', { [WEB_ENV]: WEB_ID });

    expect(config.isGoogleAuthConfigured()).toBe(true);
  });

  it('is false on an unrecognised OS when only the iOS ID is set', () => {
    const config = loadOauthConfig('macos', { [IOS_ENV]: IOS_ID });

    expect(config.isGoogleAuthConfigured()).toBe(false);
  });

  it('is false when the platform client ID is an empty string', () => {
    const config = loadOauthConfig('ios', { [IOS_ENV]: '' });

    expect(config.isGoogleAuthConfigured()).toBe(false);
  });

  // A ``.env`` line like ``EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS=" "`` is a
  // misconfiguration, not a configuration: promptAsync would fail at runtime.
  it('is false when the platform client ID is whitespace only', () => {
    const config = loadOauthConfig('ios', { [IOS_ENV]: '   ' });

    expect(config.isGoogleAuthConfigured()).toBe(false);
  });

  it('is false when no client ID is set at all', () => {
    const config = loadOauthConfig('android', {});

    expect(config.isGoogleAuthConfigured()).toBe(false);
  });
});
