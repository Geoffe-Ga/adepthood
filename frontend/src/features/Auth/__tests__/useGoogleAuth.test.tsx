/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useAuthRequest } from 'expo-auth-session/providers/google';
import React from 'react';

jest.mock('expo-auth-session/providers/google', () => ({
  useAuthRequest: jest.fn(),
}));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ApiError: actual.ApiError,
    ApiTimeoutError: actual.ApiTimeoutError,
    ApiValidationError: actual.ApiValidationError,
    auth: {
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

import { useGoogleAuth } from '../useGoogleAuth';

import { ApiError, auth } from '@/api';
import { USER_FACING_ERROR_MESSAGES } from '@/api/errorMessages';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { loadToken, saveToken } from '@/storage/authStorage';

const DEVICE_TIMEZONE = 'America/Chicago';
const ID_TOKEN = 'google-id-token-header.google-id-token-payload.google-id-token-signature';
const OTHER_ID_TOKEN = 'second-header.second-payload.second-signature';
const SESSION_JWT = 'session.jwt.signature';
const VALID_LICENSE_KEY = 'A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6'; // pragma: allowlist secret
const AUTH_REQUEST = { url: 'https://accounts.google.com/o/oauth2/v2/auth' };
/** Asserted by value: the hook keeps its fallback copy module-private on purpose. */
const GOOGLE_FALLBACK_COPY = "We couldn't finish that Google sign-in. Try again in a moment.";

const mockUseAuthRequest = useAuthRequest as unknown as jest.Mock;
const mockOauthGoogle = auth.oauthGoogle as unknown as jest.Mock;
const mockSaveToken = saveToken as jest.MockedFunction<typeof saveToken>;
const mockLoadToken = loadToken as jest.MockedFunction<typeof loadToken>;

const promptAsync = jest.fn();
let currentResponse: unknown = null;
let renderTick = 0;

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

function googleSuccess(idToken: string) {
  return { type: 'success', params: { id_token: idToken }, authentication: null };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

function renderGoogleAuth() {
  return renderHook((_props: { tick: number }) => ({ google: useGoogleAuth(), auth: useAuth() }), {
    wrapper,
    initialProps: { tick: 0 },
  });
}

type Harness = ReturnType<typeof renderGoogleAuth>;

async function readyHarness(): Promise<Harness> {
  const harness = renderGoogleAuth();
  await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('anonymous'));
  return harness;
}

/**
 * ``expo-auth-session`` surfaces the browser result by handing back a new
 * ``response`` object on the next render — this is that next render.
 */
async function deliverGoogleResponse(harness: Harness, response: unknown): Promise<void> {
  currentResponse = response;
  renderTick += 1;
  await act(async () => {
    harness.rerender({ tick: renderTick });
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function signInAndDeliver(harness: Harness, idToken: string): Promise<void> {
  act(() => {
    harness.result.current.google.signIn();
  });
  await deliverGoogleResponse(harness, googleSuccess(idToken));
}

/** Drive the flow to the inline license step and return the copy shown. */
async function reachLicenseStep(harness: Harness): Promise<string | null> {
  mockOauthGoogle.mockRejectedValueOnce(new ApiError(409, 'needs_license'));
  await signInAndDeliver(harness, ID_TOKEN);
  await waitFor(() => expect(harness.result.current.google.status).toBe('needsLicense'));
  return harness.result.current.google.error;
}

beforeEach(() => {
  jest.clearAllMocks();
  currentResponse = null;
  renderTick = 0;
  mockLoadToken.mockResolvedValue(null);
  promptAsync.mockResolvedValue({ type: 'dismiss' });
  mockUseAuthRequest.mockImplementation(() => [AUTH_REQUEST, currentResponse, promptAsync]);
});

describe('useGoogleAuth — success', () => {
  it('applies the auth response and authenticates the device on a 200 exchange', async () => {
    mockOauthGoogle.mockResolvedValue({
      token: SESSION_JWT,
      user_id: 7,
      timezone: DEVICE_TIMEZONE,
    });
    const harness = await readyHarness();

    await signInAndDeliver(harness, ID_TOKEN);

    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockSaveToken).toHaveBeenCalledWith(SESSION_JWT);
    expect(harness.result.current.auth.token).toBe(SESSION_JWT);
    expect(harness.result.current.auth.userTimezone).toBe(DEVICE_TIMEZONE);
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.error).toBeNull();
  });

  it('clears the pending id token once the exchange succeeds', async () => {
    // The ref is not directly observable, so probe it the way the UI would:
    // a license submit with nothing pending must not reach the network.
    mockOauthGoogle.mockResolvedValue({ token: SESSION_JWT, user_id: 7 });
    const harness = await readyHarness();
    await signInAndDeliver(harness, ID_TOKEN);
    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));

    mockOauthGoogle.mockClear();
    await act(async () => {
      harness.result.current.google.submitLicenseKey(VALID_LICENSE_KEY);
    });

    expect(mockOauthGoogle).not.toHaveBeenCalled();
  });

  it('sends the detected device timezone with the exchange', async () => {
    mockOauthGoogle.mockResolvedValue({ token: SESSION_JWT, user_id: 7 });
    const harness = await readyHarness();

    await signInAndDeliver(harness, ID_TOKEN);

    await waitFor(() => expect(mockOauthGoogle).toHaveBeenCalledTimes(1));
    expect(mockOauthGoogle).toHaveBeenCalledWith({
      id_token: ID_TOKEN,
      timezone: DEVICE_TIMEZONE,
    });
  });
});

describe('useGoogleAuth — needs_license routing', () => {
  it('routes a 409 to the license step without mutating auth state', async () => {
    const harness = await readyHarness();

    await reachLicenseStep(harness);

    expect(harness.result.current.google.status).toBe('needsLicense');
    expect(harness.result.current.auth.authStatus).toBe('anonymous');
    expect(harness.result.current.auth.token).toBeNull();
    expect(mockSaveToken).not.toHaveBeenCalled();
    expect(mockOauthGoogle).toHaveBeenCalledWith({
      id_token: ID_TOKEN,
      timezone: DEVICE_TIMEZONE,
    });
  });

  it('re-sends the same id token with the license key and never prompts Google twice', async () => {
    const harness = await readyHarness();
    await reachLicenseStep(harness);

    mockOauthGoogle.mockResolvedValueOnce({ token: SESSION_JWT, user_id: 11 });
    await act(async () => {
      harness.result.current.google.submitLicenseKey(VALID_LICENSE_KEY);
    });

    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockOauthGoogle).toHaveBeenNthCalledWith(2, {
      id_token: ID_TOKEN,
      license_key: VALID_LICENSE_KEY,
      timezone: DEVICE_TIMEZONE,
    });
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  it('leaves the user on the license step when the submitted key is also refused', async () => {
    const harness = await readyHarness();
    await reachLicenseStep(harness);

    mockOauthGoogle.mockRejectedValueOnce(new ApiError(409, 'needs_license'));
    await act(async () => {
      harness.result.current.google.submitLicenseKey(VALID_LICENSE_KEY);
    });

    await waitFor(() => expect(harness.result.current.google.submitting).toBe(false));
    expect(harness.result.current.google.status).toBe('needsLicense');
    expect(harness.result.current.auth.authStatus).toBe('anonymous');
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});

describe('useGoogleAuth — stale response guard', () => {
  it('ignores a second tap while an exchange is already in flight', async () => {
    const pending = deferred<{ token: string; user_id: number }>();
    mockOauthGoogle.mockReturnValue(pending.promise);
    const harness = await readyHarness();

    await signInAndDeliver(harness, ID_TOKEN);
    await waitFor(() => expect(mockOauthGoogle).toHaveBeenCalledTimes(1));

    act(() => {
      harness.result.current.google.signIn();
    });

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(mockOauthGoogle).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ token: SESSION_JWT, user_id: 4 });
    });
  });

  // The in-flight guard gates the *prompt*, not the response effect: a fresh
  // Google response supersedes the previous attempt, and only the newest
  // attempt may write state.
  it('drops a needs_license whose google response was superseded by a newer one', async () => {
    const stale = deferred<{ token: string; user_id: number }>();
    const fresh = deferred<{ token: string; user_id: number }>();
    mockOauthGoogle.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const harness = await readyHarness();

    await signInAndDeliver(harness, ID_TOKEN);
    await waitFor(() => expect(mockOauthGoogle).toHaveBeenCalledTimes(1));
    await deliverGoogleResponse(harness, googleSuccess(OTHER_ID_TOKEN));
    await waitFor(() => expect(mockOauthGoogle).toHaveBeenCalledTimes(2));

    stale.reject(new ApiError(409, 'needs_license'));
    await flushMicrotasks();

    expect(harness.result.current.google.status).toBe('idle');

    fresh.reject(new ApiError(409, 'needs_license'));
    await flushMicrotasks();

    await waitFor(() => expect(harness.result.current.google.status).toBe('needsLicense'));
  });

  it('does not update state when the exchange settles after unmount', async () => {
    const pending = deferred<{ token: string; user_id: number }>();
    mockOauthGoogle.mockReturnValue(pending.promise);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await readyHarness();
    await signInAndDeliver(harness, ID_TOKEN);
    await waitFor(() => expect(mockOauthGoogle).toHaveBeenCalledTimes(1));

    harness.unmount();
    pending.reject(new ApiError(409, 'needs_license'));
    await flushMicrotasks();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockSaveToken).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('useGoogleAuth — token hygiene', () => {
  it('returns to idle and surfaces the invalid_oauth_token copy on a 401', async () => {
    mockOauthGoogle.mockRejectedValueOnce(new ApiError(401, 'invalid_oauth_token'));
    const harness = await readyHarness();

    await signInAndDeliver(harness, ID_TOKEN);

    await waitFor(() => expect(harness.result.current.google.error).not.toBeNull());
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.error).toBe(
      USER_FACING_ERROR_MESSAGES.invalid_oauth_token,
    );
    expect(harness.result.current.auth.authStatus).toBe('anonymous');
  });

  it('discards the pending id token after a 401 so it can never be replayed', async () => {
    mockOauthGoogle.mockRejectedValueOnce(new ApiError(401, 'invalid_oauth_token'));
    const harness = await readyHarness();
    await signInAndDeliver(harness, ID_TOKEN);
    await waitFor(() => expect(harness.result.current.google.error).not.toBeNull());

    mockOauthGoogle.mockClear();
    await act(async () => {
      harness.result.current.google.submitLicenseKey(VALID_LICENSE_KEY);
    });

    expect(mockOauthGoogle).not.toHaveBeenCalled();
  });

  it('maps invalid_oauth_token to real prose rather than the raw backend code', () => {
    const copy = USER_FACING_ERROR_MESSAGES.invalid_oauth_token;

    expect(typeof copy).toBe('string');
    expect(copy).not.toContain('invalid_oauth_token');
    expect(copy).toMatch(/[.!?]$/);
  });
});

describe('useGoogleAuth — anti-enumeration', () => {
  it('shows byte-identical copy before and after a license key is submitted', async () => {
    const harness = await readyHarness();
    const firstRefusal = await reachLicenseStep(harness);

    mockOauthGoogle.mockRejectedValueOnce(new ApiError(409, 'needs_license'));
    await act(async () => {
      harness.result.current.google.submitLicenseKey(VALID_LICENSE_KEY);
    });
    await waitFor(() => expect(harness.result.current.google.submitting).toBe(false));
    const secondRefusal = harness.result.current.google.error;

    expect(firstRefusal).toBe(USER_FACING_ERROR_MESSAGES.needs_license);
    expect(secondRefusal).toBe(firstRefusal);
    expect(typeof firstRefusal).toBe('string');
    expect(firstRefusal).not.toBe('');
  });

  // Every non-cryptographic failure collapses to one 409, so the copy must not
  // hint at which one it was — that hint is the enumeration oracle.
  it.each([['email'], ['account'], ['verified'], ['disabled']])(
    'never names %p as the cause of the refusal',
    (word) => {
      expect(USER_FACING_ERROR_MESSAGES.needs_license).toEqual(expect.any(String));
      expect(USER_FACING_ERROR_MESSAGES.needs_license).not.toMatch(new RegExp(word, 'i'));
    },
  );

  it('never leaks the raw google id token into hook state or error copy', async () => {
    const harness = await readyHarness();
    await reachLicenseStep(harness);

    expect(JSON.stringify(harness.result.current.google)).not.toContain(ID_TOKEN);
    expect(harness.result.current.google.error).not.toContain(ID_TOKEN);
  });

  it('never leaks the raw google id token after a 401', async () => {
    mockOauthGoogle.mockRejectedValueOnce(new ApiError(401, 'invalid_oauth_token'));
    const harness = await readyHarness();
    await signInAndDeliver(harness, ID_TOKEN);
    await waitFor(() => expect(harness.result.current.google.error).not.toBeNull());

    expect(JSON.stringify(harness.result.current.google)).not.toContain(ID_TOKEN);
  });
});

describe('useGoogleAuth — dismissed prompt', () => {
  it('stays idle and silent when the user closes the Google sheet', async () => {
    const harness = await readyHarness();

    act(() => {
      harness.result.current.google.signIn();
    });
    await deliverGoogleResponse(harness, { type: 'dismiss' });
    await flushMicrotasks();

    expect(mockOauthGoogle).not.toHaveBeenCalled();
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.error).toBeNull();
    expect(harness.result.current.google.submitting).toBe(false);
  });

  it('releases the in-flight guard so a dismissed prompt can be retried', async () => {
    const harness = await readyHarness();
    act(() => {
      harness.result.current.google.signIn();
    });
    await deliverGoogleResponse(harness, { type: 'dismiss' });
    await flushMicrotasks();

    act(() => {
      harness.result.current.google.signIn();
    });

    expect(promptAsync).toHaveBeenCalledTimes(2);
  });
});

describe('useGoogleAuth — unexpected failures', () => {
  it('surfaces a network failure without entering the license step', async () => {
    mockOauthGoogle.mockRejectedValueOnce(new TypeError('Network request failed'));
    const harness = await readyHarness();

    await signInAndDeliver(harness, ID_TOKEN);

    await waitFor(() => expect(harness.result.current.google.error).not.toBeNull());
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.error).toBe(USER_FACING_ERROR_MESSAGES.network_error);
    expect(harness.result.current.auth.authStatus).toBe('anonymous');
  });

  it('surfaces the fallback copy when a success response carries no id token', async () => {
    const harness = await readyHarness();

    act(() => {
      harness.result.current.google.signIn();
    });
    await deliverGoogleResponse(harness, { type: 'success', params: {}, authentication: null });
    await flushMicrotasks();

    expect(harness.result.current.google.error).toBe(GOOGLE_FALLBACK_COPY);
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.submitting).toBe(false);
    expect(mockOauthGoogle).not.toHaveBeenCalled();
    expect(harness.result.current.auth.authStatus).toBe('anonymous');
  });

  it('surfaces the fallback copy and frees the guard when the prompt itself rejects', async () => {
    promptAsync.mockRejectedValueOnce(new Error('no browser available'));
    const harness = await readyHarness();

    await act(async () => {
      harness.result.current.google.signIn();
    });

    await waitFor(() => expect(harness.result.current.google.error).not.toBeNull());
    expect(harness.result.current.google.error).toBe(GOOGLE_FALLBACK_COPY);
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.submitting).toBe(false);
    expect(mockOauthGoogle).not.toHaveBeenCalled();

    act(() => {
      harness.result.current.google.signIn();
    });

    expect(promptAsync).toHaveBeenCalledTimes(2);
  });
});
