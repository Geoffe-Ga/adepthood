/* eslint-env jest */
/* global describe, it, expect, beforeEach, afterEach, jest */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import {
  isAvailableAsync,
  signInAsync,
  AppleAuthenticationUserDetectionStatus,
  type AppleAuthenticationCredential,
  type AppleAuthenticationFullName,
} from 'expo-apple-authentication';
import React from 'react';
import { Platform } from 'react-native';

jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(true)),
  signInAsync: jest.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  AppleAuthenticationUserDetectionStatus: { UNSUPPORTED: 0, UNKNOWN: 1, LIKELY_REAL: 2 },
}));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ApiError: actual.ApiError,
    ApiTimeoutError: actual.ApiTimeoutError,
    ApiValidationError: actual.ApiValidationError,
    auth: {
      oauthApple: jest.fn(),
      oauthGoogle: jest.fn(),
      login: jest.fn(),
      signup: jest.fn(),
      refresh: jest.fn(),
      requestPasswordReset: jest.fn(),
      confirmPasswordReset: jest.fn(),
      cancelPasswordReset: jest.fn(),
    },
    setTokenGetter: jest.fn(),
    setOnUnauthorized: jest.fn(),
    setOnTokenRefreshed: jest.fn(),
    resetLlmApiKey: jest.fn(),
  };
});

jest.mock('@/storage/authStorage', () => ({
  saveToken: jest.fn(() => Promise.resolve()),
  loadToken: jest.fn(() => Promise.resolve(null)),
  clearToken: jest.fn(() => Promise.resolve()),
  markLogoutPending: jest.fn(() => Promise.resolve()),
  isLogoutPending: jest.fn(() => Promise.resolve(false)),
  clearLogoutPending: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/utils/token', () => ({
  decodeJwtPayload: jest.fn(() => null),
  isTokenExpired: jest.fn(() => false),
  shouldRefreshToken: jest.fn(() => false),
  REFRESH_BUFFER_SECONDS: 300,
}));

jest.mock('@/utils/dateUtils', () => ({
  ...jest.requireActual('@/utils/dateUtils'),
  detectDeviceTimezone: jest.fn(() => 'America/Chicago'),
}));

import { useAppleAuth, useAppleSignInAvailable } from '../useAppleAuth';

import { ApiError, auth } from '@/api';
import { USER_FACING_ERROR_MESSAGES } from '@/api/errorMessages';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import * as authStorage from '@/storage/authStorage';
import { loadToken, saveToken } from '@/storage/authStorage';

const DEVICE_TIMEZONE = 'America/Chicago';
const APPLE_ID_TOKEN = 'apple-id-token-header.apple-id-token-payload.apple-id-token-signature';
const APPLE_USER_ID = '001234.abcdef0123456789abcdef0123456789.0000';
const AUTHORIZATION_CODE = 'apple-authorization-code';
const SESSION_JWT = 'session.jwt.signature';
const VALID_LICENSE_KEY = 'A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6'; // pragma: allowlist secret
const GIVEN_NAME = 'Ada';
const FAMILY_NAME = 'Lovelace';
const JOINED_NAME = 'Ada Lovelace';
/** Asserted by value: the hook keeps its fallback copy module-private on purpose. */
const APPLE_FALLBACK_COPY = "We couldn't finish that Apple sign-in. Try again in a moment.";
/** The coded rejection ``expo-apple-authentication`` raises when the user backs out. */
const CANCEL_CODE = 'ERR_REQUEST_CANCELED';
/**
 * Everything one Apple authorization yields that is the provider's to hold and
 * ours to spend once. None of it may reach the device's disk: the session JWT
 * is the only credential worth persisting.
 */
const APPLE_ONLY_SECRETS = [APPLE_ID_TOKEN, JOINED_NAME, GIVEN_NAME, FAMILY_NAME];

const mockIsAvailableAsync = isAvailableAsync as unknown as jest.Mock;
const mockSignInAsync = signInAsync as unknown as jest.Mock;
const mockOauthApple = auth.oauthApple as unknown as jest.Mock;
const mockSaveToken = saveToken as jest.MockedFunction<typeof saveToken>;
const mockLoadToken = loadToken as jest.MockedFunction<typeof loadToken>;

interface SessionResponse {
  token: string;
  user_id: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (_value: T) => void;
  reject: (_reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (_value: T) => void = () => undefined;
  let reject: (_reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appleFullName(parts: Partial<AppleAuthenticationFullName>): AppleAuthenticationFullName {
  return {
    namePrefix: null,
    givenName: null,
    middleName: null,
    familyName: null,
    nameSuffix: null,
    nickname: null,
    ...parts,
  };
}

function appleCredential(
  overrides: Partial<AppleAuthenticationCredential> = {},
): AppleAuthenticationCredential {
  return {
    user: APPLE_USER_ID,
    state: null,
    fullName: null,
    email: null,
    realUserStatus: AppleAuthenticationUserDetectionStatus.LIKELY_REAL,
    identityToken: APPLE_ID_TOKEN,
    authorizationCode: AUTHORIZATION_CODE,
    ...overrides,
  };
}

function namedCredential(): AppleAuthenticationCredential {
  return appleCredential({
    fullName: appleFullName({ givenName: GIVEN_NAME, familyName: FAMILY_NAME }),
  });
}

/** The rejection shape Apple uses for "the user closed the sheet". */
function cancelRejection(): Error {
  return Object.assign(new Error('The user canceled the authorization attempt'), {
    code: CANCEL_CODE,
  });
}

function payloadFor(index: number): Record<string, unknown> {
  const [payload] = mockOauthApple.mock.calls[index] as [Record<string, unknown>];
  return payload;
}

/**
 * Every argument handed to every persistence entry point, as one searchable
 * string — a leak through any of them, not just ``saveToken``, is a leak.
 */
function persistedArguments(): string {
  const calls = Object.values(authStorage)
    .map((entry) => (entry as unknown as { mock?: { calls: unknown[][] } }).mock?.calls)
    .filter((entry) => entry !== undefined);
  expect(calls).not.toHaveLength(0);
  return JSON.stringify(calls);
}

function expectNoAppleSecrets(serialized: string): void {
  for (const secret of APPLE_ONLY_SECRETS) expect(serialized).not.toContain(secret);
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

function renderAppleAuth() {
  return renderHook(() => ({ apple: useAppleAuth(), auth: useAuth() }), { wrapper });
}

type Harness = ReturnType<typeof renderAppleAuth>;

async function readyHarness(): Promise<Harness> {
  const harness = renderAppleAuth();
  await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('anonymous'));
  return harness;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pressSignIn(harness: Harness): Promise<void> {
  await act(async () => {
    harness.result.current.apple.signIn();
  });
  await flushMicrotasks();
}

/** Drive the flow to the inline license step and return the copy shown. */
async function reachLicenseStep(
  harness: Harness,
  credential: AppleAuthenticationCredential,
): Promise<string | null> {
  mockSignInAsync.mockResolvedValueOnce(credential);
  mockOauthApple.mockRejectedValueOnce(new ApiError(409, 'needs_license'));
  await pressSignIn(harness);
  await waitFor(() => expect(harness.result.current.apple.status).toBe('needsLicense'));
  return harness.result.current.apple.error;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadToken.mockResolvedValue(null);
  mockIsAvailableAsync.mockResolvedValue(true);
  mockSignInAsync.mockResolvedValue(appleCredential());
  mockOauthApple.mockResolvedValue({ token: SESSION_JWT, user_id: 9, timezone: DEVICE_TIMEZONE });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useAppleAuth — success', () => {
  it('authenticates the device when the exchange succeeds', async () => {
    const harness = await readyHarness();

    await pressSignIn(harness);

    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockSaveToken).toHaveBeenCalledWith(SESSION_JWT);
    expect(harness.result.current.auth.token).toBe(SESSION_JWT);
    expect(harness.result.current.auth.userTimezone).toBe(DEVICE_TIMEZONE);
    expect(harness.result.current.apple.status).toBe('idle');
    expect(harness.result.current.apple.error).toBeNull();
  });

  it('clears the pending credential once the exchange succeeds', async () => {
    const harness = await readyHarness();
    await pressSignIn(harness);
    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));

    mockOauthApple.mockClear();
    await act(async () => {
      harness.result.current.apple.submitLicenseKey(VALID_LICENSE_KEY);
    });

    expect(mockOauthApple).not.toHaveBeenCalled();
  });
});

describe('useAppleAuth — request payload', () => {
  it('omits full_name entirely when Apple withholds the name', async () => {
    const harness = await readyHarness();

    await pressSignIn(harness);

    await waitFor(() => expect(mockOauthApple).toHaveBeenCalledTimes(1));
    expect(mockOauthApple).toHaveBeenCalledWith({
      id_token: APPLE_ID_TOKEN,
      timezone: DEVICE_TIMEZONE,
    });
    expect(Object.keys(payloadFor(0))).not.toContain('full_name');
  });

  const NAME_CASES: Array<[Partial<AppleAuthenticationFullName>, string]> = [
    [{ givenName: GIVEN_NAME, familyName: FAMILY_NAME }, JOINED_NAME],
    [{ givenName: GIVEN_NAME }, GIVEN_NAME],
    [{ familyName: FAMILY_NAME }, FAMILY_NAME],
    // Each part is trimmed before the join, never after: joining first would
    // leave the padding buried inside the name as ``Ada   Lovelace``.
    [{ givenName: `  ${GIVEN_NAME}  `, familyName: FAMILY_NAME }, JOINED_NAME],
  ];

  it.each(NAME_CASES)('joins the name parts %o into full_name %p', async (parts, expected) => {
    mockSignInAsync.mockResolvedValueOnce(appleCredential({ fullName: appleFullName(parts) }));
    const harness = await readyHarness();

    await pressSignIn(harness);

    await waitFor(() => expect(mockOauthApple).toHaveBeenCalledTimes(1));
    expect(mockOauthApple).toHaveBeenCalledWith({
      id_token: APPLE_ID_TOKEN,
      full_name: expected,
      timezone: DEVICE_TIMEZONE,
    });
  });

  const BLANK_NAME_CASES: Array<[string, Partial<AppleAuthenticationFullName>]> = [
    ['every part is null', {}],
    ['every supplied part is whitespace', { givenName: '   ', familyName: ' ' }],
  ];

  it.each(BLANK_NAME_CASES)('sends no full_name key when %s', async (_label, parts) => {
    mockSignInAsync.mockResolvedValueOnce(appleCredential({ fullName: appleFullName(parts) }));
    const harness = await readyHarness();

    await pressSignIn(harness);

    await waitFor(() => expect(mockOauthApple).toHaveBeenCalledTimes(1));
    expect(Object.keys(payloadFor(0))).not.toContain('full_name');
  });
});

describe('useAppleAuth — needs_license routing', () => {
  it('routes a 409 to the license step without mutating auth state', async () => {
    const harness = await readyHarness();

    await reachLicenseStep(harness, appleCredential());

    expect(harness.result.current.apple.status).toBe('needsLicense');
    expect(harness.result.current.auth.authStatus).toBe('anonymous');
    expect(harness.result.current.auth.token).toBeNull();
    expect(mockSaveToken).not.toHaveBeenCalled();
  });

  // Apple hands over the user's name exactly once — on the very first
  // authorization. If the license retry dropped it, that name is gone forever.
  it('re-sends the same id token and name with the license key, without a second sheet', async () => {
    const harness = await readyHarness();
    await reachLicenseStep(harness, namedCredential());

    mockOauthApple.mockResolvedValueOnce({ token: SESSION_JWT, user_id: 11 });
    await act(async () => {
      harness.result.current.apple.submitLicenseKey(VALID_LICENSE_KEY);
    });

    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockOauthApple).toHaveBeenNthCalledWith(2, {
      id_token: APPLE_ID_TOKEN,
      full_name: JOINED_NAME,
      license_key: VALID_LICENSE_KEY,
      timezone: DEVICE_TIMEZONE,
    });
    expect(mockSignInAsync).toHaveBeenCalledTimes(1);
  });

  it('leaves the user on the license step when the submitted key is also refused', async () => {
    const harness = await readyHarness();
    await reachLicenseStep(harness, appleCredential());

    mockOauthApple.mockRejectedValueOnce(new ApiError(409, 'needs_license'));
    await act(async () => {
      harness.result.current.apple.submitLicenseKey(VALID_LICENSE_KEY);
    });

    await waitFor(() => expect(harness.result.current.apple.submitting).toBe(false));
    expect(harness.result.current.apple.status).toBe('needsLicense');
    expect(harness.result.current.auth.authStatus).toBe('anonymous');
    expect(mockSignInAsync).toHaveBeenCalledTimes(1);
  });
});

describe('useAppleAuth — anti-enumeration', () => {
  it('shows byte-identical refusal copy before and after a license key is submitted', async () => {
    const harness = await readyHarness();
    const firstRefusal = await reachLicenseStep(harness, appleCredential());

    mockOauthApple.mockRejectedValueOnce(new ApiError(409, 'needs_license'));
    await act(async () => {
      harness.result.current.apple.submitLicenseKey(VALID_LICENSE_KEY);
    });
    await waitFor(() => expect(harness.result.current.apple.submitting).toBe(false));
    const secondRefusal = harness.result.current.apple.error;

    expect(firstRefusal).toBe(USER_FACING_ERROR_MESSAGES.needs_license);
    expect(secondRefusal).toBe(firstRefusal);
  });
});

describe('useAppleAuth — cancellation', () => {
  it('stays idle and silent when the user closes the Apple sheet', async () => {
    mockSignInAsync.mockRejectedValueOnce(cancelRejection());
    const harness = await readyHarness();

    await pressSignIn(harness);

    expect(mockOauthApple).not.toHaveBeenCalled();
    expect(harness.result.current.apple.status).toBe('idle');
    expect(harness.result.current.apple.error).toBeNull();
    expect(harness.result.current.apple.submitting).toBe(false);
  });

  it('releases the in-flight guard so a cancelled sheet can be reopened', async () => {
    mockSignInAsync.mockRejectedValueOnce(cancelRejection());
    const harness = await readyHarness();
    await pressSignIn(harness);

    await pressSignIn(harness);

    expect(mockSignInAsync).toHaveBeenCalledTimes(2);
  });
});

describe('useAppleAuth — unexpected failures', () => {
  // Both spellings mean the same thing — the sheet came back with nothing to
  // exchange — and an empty token is no more sendable than an absent one.
  const ABSENT_TOKEN_CASES: Array<[string, string | null]> = [
    ['is null', null],
    ['is an empty string', ''],
  ];

  it.each(ABSENT_TOKEN_CASES)(
    'surfaces the fallback copy when the identity token %s',
    async (_label, identityToken) => {
      mockSignInAsync.mockResolvedValueOnce(appleCredential({ identityToken }));
      const harness = await readyHarness();

      await pressSignIn(harness);

      expect(harness.result.current.apple.error).toBe(APPLE_FALLBACK_COPY);
      expect(harness.result.current.apple.status).toBe('idle');
      expect(harness.result.current.apple.submitting).toBe(false);
      expect(mockOauthApple).not.toHaveBeenCalled();
    },
  );

  it.each(ABSENT_TOKEN_CASES)(
    'releases the guard, with no exchange spent, when the identity token %s',
    async (_label, identityToken) => {
      mockSignInAsync.mockResolvedValue(appleCredential({ identityToken }));
      const harness = await readyHarness();
      await pressSignIn(harness);

      await pressSignIn(harness);

      expect(mockSignInAsync).toHaveBeenCalledTimes(2);
      expect(mockOauthApple).not.toHaveBeenCalled();
    },
  );

  // A cancel is silent; anything else is a real failure and must say so.
  it('surfaces the fallback copy when the Apple sheet fails for any other reason', async () => {
    mockSignInAsync.mockRejectedValueOnce(new Error('boom'));
    const harness = await readyHarness();

    await pressSignIn(harness);

    expect(harness.result.current.apple.error).toBe(APPLE_FALLBACK_COPY);
    expect(harness.result.current.apple.status).toBe('idle');
    expect(harness.result.current.apple.submitting).toBe(false);
    expect(mockOauthApple).not.toHaveBeenCalled();
  });
});

describe('useAppleAuth — token hygiene', () => {
  it('returns to idle and surfaces the invalid_oauth_token copy on a 401', async () => {
    mockOauthApple.mockRejectedValueOnce(new ApiError(401, 'invalid_oauth_token'));
    const harness = await readyHarness();

    await pressSignIn(harness);

    await waitFor(() => expect(harness.result.current.apple.error).not.toBeNull());
    expect(harness.result.current.apple.status).toBe('idle');
    expect(harness.result.current.apple.error).toBe(USER_FACING_ERROR_MESSAGES.invalid_oauth_token);
    expect(harness.result.current.auth.authStatus).toBe('anonymous');
  });

  it('discards the pending credential after a 401 so it can never be replayed', async () => {
    mockOauthApple.mockRejectedValueOnce(new ApiError(401, 'invalid_oauth_token'));
    const harness = await readyHarness();
    await pressSignIn(harness);
    await waitFor(() => expect(harness.result.current.apple.error).not.toBeNull());

    mockOauthApple.mockClear();
    await act(async () => {
      harness.result.current.apple.submitLicenseKey(VALID_LICENSE_KEY);
    });

    expect(mockOauthApple).not.toHaveBeenCalled();
  });

  it('never leaks the identity token or the name into hook state or error copy', async () => {
    const harness = await readyHarness();
    await reachLicenseStep(harness, namedCredential());

    const serialized = JSON.stringify(harness.result.current.apple);
    expect(serialized).not.toContain(APPLE_ID_TOKEN);
    expect(serialized).not.toContain(JOINED_NAME);
    expect(serialized).not.toContain(GIVEN_NAME);
    expect(harness.result.current.apple.error).not.toContain(APPLE_ID_TOKEN);
    expect(harness.result.current.apple.error).not.toContain(GIVEN_NAME);
  });

  // Serializing the hook's return value only reaches its three plain fields, so
  // the invariant that actually matters — nothing reaches the disk — has to be
  // read off the persistence layer's own call records.
  it('writes nothing to storage while the license step holds the credential', async () => {
    const harness = await readyHarness();
    await reachLicenseStep(harness, namedCredential());

    expect(mockSaveToken).not.toHaveBeenCalled();
    expectNoAppleSecrets(JSON.stringify(mockSaveToken.mock.calls));
    expectNoAppleSecrets(persistedArguments());
  });

  it('persists the session token and nothing else once the exchange succeeds', async () => {
    mockSignInAsync.mockResolvedValueOnce(namedCredential());
    const harness = await readyHarness();

    await pressSignIn(harness);

    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockSaveToken.mock.calls).toEqual([[SESSION_JWT]]);
    expectNoAppleSecrets(JSON.stringify(mockSaveToken.mock.calls));
    // The session JWT proves the sweep really reads the persistence layer, so
    // the absences below are findings rather than an empty search.
    expect(persistedArguments()).toContain(SESSION_JWT);
    expectNoAppleSecrets(persistedArguments());
  });
});

describe('useAppleAuth — in-flight guard', () => {
  it('ignores a second tap while an exchange is already in flight', async () => {
    const pending = deferred<SessionResponse>();
    mockOauthApple.mockReturnValueOnce(pending.promise);
    const harness = await readyHarness();

    await pressSignIn(harness);
    await waitFor(() => expect(mockOauthApple).toHaveBeenCalledTimes(1));

    await pressSignIn(harness);

    expect(mockSignInAsync).toHaveBeenCalledTimes(1);
    expect(mockOauthApple).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ token: SESSION_JWT, user_id: 4 });
    });
  });

  it('does not update state when the exchange settles after unmount', async () => {
    const pending = deferred<SessionResponse>();
    mockOauthApple.mockReturnValueOnce(pending.promise);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await readyHarness();
    await pressSignIn(harness);
    await waitFor(() => expect(mockOauthApple).toHaveBeenCalledTimes(1));

    harness.unmount();
    pending.reject(new ApiError(409, 'needs_license'));
    await flushMicrotasks();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockSaveToken).not.toHaveBeenCalled();
  });
});

describe('useAppleSignInAvailable', () => {
  it('reports available on iOS when Apple says the feature is there', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    mockIsAvailableAsync.mockResolvedValue(true);

    const { result } = renderHook(() => useAppleSignInAvailable());

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('stays unavailable on iOS when Apple reports the feature missing', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    mockIsAvailableAsync.mockResolvedValue(false);

    const { result } = renderHook(() => useAppleSignInAvailable());
    await waitFor(() => expect(mockIsAvailableAsync).toHaveBeenCalledTimes(1));
    await flushMicrotasks();

    expect(result.current).toBe(false);
  });

  it('treats a rejected availability probe as unavailable and stays quiet', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    mockIsAvailableAsync.mockRejectedValue(new Error('no native module'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const { result } = renderHook(() => useAppleSignInAvailable());
    await waitFor(() => expect(mockIsAvailableAsync).toHaveBeenCalledTimes(1));
    await flushMicrotasks();

    expect(result.current).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // Reading ``Platform.OS`` at module scope would make this unobservable, so
  // the probe has to happen inside the effect.
  it('never probes Apple off iOS', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    mockIsAvailableAsync.mockResolvedValue(true);

    const { result } = renderHook(() => useAppleSignInAvailable());
    await flushMicrotasks();

    expect(result.current).toBe(false);
    expect(mockIsAvailableAsync).not.toHaveBeenCalled();
  });
});
