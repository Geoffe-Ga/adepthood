/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { exchangeCodeAsync } from 'expo-auth-session';
import { useAuthRequest } from 'expo-auth-session/providers/google';
import React from 'react';

jest.mock('expo-auth-session/providers/google', () => ({
  useAuthRequest: jest.fn(),
  discovery: { tokenEndpoint: 'https://oauth2.googleapis.com/token' },
}));

jest.mock('expo-auth-session', () => ({
  exchangeCodeAsync: jest.fn(),
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
      requestPasswordReset: jest.fn(),
      confirmPasswordReset: jest.fn(),
      cancelPasswordReset: jest.fn(),
    },
    refreshSessionToken: jest.fn(),
    resetTokenRotations: jest.fn(),
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
  saveUserTimezone: jest.fn(() => Promise.resolve()),
  loadUserTimezone: jest.fn(() => Promise.resolve('UTC')),
  clearUserTimezone: jest.fn(() => Promise.resolve()),
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
import { UNREACHABLE_MESSAGE, USER_FACING_ERROR_MESSAGES } from '@/api/errorMessages';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { loadToken, saveToken } from '@/storage/authStorage';

const DEVICE_TIMEZONE = 'America/Chicago';
const ID_TOKEN = 'google-id-token-header.google-id-token-payload.google-id-token-signature';
const OTHER_ID_TOKEN = 'second-header.second-payload.second-signature';
const SESSION_JWT = 'session.jwt.signature';
const VALID_LICENSE_KEY = 'A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6'; // pragma: allowlist secret
const AUTH_REQUEST = {
  url: 'https://accounts.google.com/o/oauth2/v2/auth',
  clientId: 'native-client-id.apps.googleusercontent.com',
  redirectUri: 'com.example.adepthood:/oauthredirect',
  codeVerifier: 'pkce-code-verifier',
};
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** The one-time authorization code native's code flow redirects back with. */
const AUTH_CODE = 'one-time-authorization-code';
/** Asserted by value: the hook keeps its fallback copy module-private on purpose. */
const GOOGLE_FALLBACK_COPY = "We couldn't finish that Google sign-in. Try again in a moment.";
/** Asserted by value: the copy for a refusal Google itself reported on the redirect (#1989). */
const GOOGLE_PROVIDER_ERROR_COPY =
  "Google couldn't complete that sign-in. Try again, or continue with email instead.";
/** A provider description that must never reach the screen or hook state. */
const PROVIDER_SENTINEL = 'SENTINEL-PROVIDER-DESCRIPTION';
const PROVIDER_REDIRECT_URL = 'https://example.invalid/redirect';
/** Google's code for a user who pressed Cancel or Deny on its own screen. */
const USER_DECLINED_CODE = 'access_denied';

const mockUseAuthRequest = useAuthRequest as unknown as jest.Mock;
const mockOauthGoogle = auth.oauthGoogle as unknown as jest.Mock;
const mockExchangeCodeAsync = exchangeCodeAsync as unknown as jest.Mock;
const mockSaveToken = saveToken as jest.MockedFunction<typeof saveToken>;
const mockLoadToken = loadToken as jest.MockedFunction<typeof loadToken>;

const promptAsync = jest.fn();
let currentResponse: unknown = null;
/**
 * The provider's loaded request. Like ``useLoadedAuthRequest`` it is ``null``
 * on the first render and only appears once the auth URL has been built.
 */
let currentRequest: typeof AUTH_REQUEST | null = null;
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

/** Native's code-flow redirect: a code to trade, and no id token yet. */
function googleCodeSuccess() {
  return {
    type: 'success',
    errorCode: null,
    error: null,
    params: { code: AUTH_CODE, state: 'request-state' },
    authentication: null,
    url: 'com.example.adepthood:/oauthredirect?code=one-time-authorization-code',
  };
}

function isCodeResult(response: unknown): boolean {
  if (typeof response !== 'object' || response === null || !('params' in response)) return false;
  const { params } = response as { params: Record<string, string> };
  return params.code !== undefined && params.id_token === undefined;
}

/**
 * The provider as ``expo-auth-session`` 57.0.13 behaves: unless auto-exchange
 * is switched off, it withholds a code result while it trades the code
 * itself, and its trade has no ``.catch`` — a refused trade never delivers a
 * response at all. That withheld-forever result is what this fake hands back.
 */
function providerResponse(config: { shouldAutoExchangeCode?: boolean } | undefined): unknown {
  const autoExchanges = config?.shouldAutoExchangeCode !== false;
  return autoExchanges && isCodeResult(currentResponse) ? null : currentResponse;
}

function googleSuccess(idToken: string) {
  return { type: 'success', params: { id_token: idToken }, authentication: null };
}

interface ProviderErrorShape {
  /** Put the code on the ``AuthError`` (the current library shape). */
  withAuthError?: boolean;
  /** Put the code on the raw redirect ``params`` (the legacy shape). */
  withParams?: boolean;
}

/**
 * An ``error`` result as ``expo-auth-session`` builds it from a redirect that
 * carries ``error=<code>``. ``null`` models a redirect with no code at all.
 */
function googleProviderError(
  code: string | null,
  { withAuthError = true, withParams = true }: ProviderErrorShape = {},
) {
  return {
    type: 'error',
    errorCode: null,
    error: withAuthError && code !== null ? { code, description: PROVIDER_SENTINEL } : null,
    params:
      withParams && code !== null ? { error: code, error_description: PROVIDER_SENTINEL } : {},
    authentication: null,
    url: PROVIDER_REDIRECT_URL,
  };
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

/** A later render with the provider's request swapped for ``request``. */
async function deliverGoogleRequest(
  harness: Harness,
  request: typeof AUTH_REQUEST | null,
): Promise<void> {
  currentRequest = request;
  renderTick += 1;
  await act(async () => {
    harness.rerender({ tick: renderTick });
  });
}

/**
 * Mount with no request yet, then let it load — the order the real provider
 * follows — unless ``loadRequest`` is off.
 */
async function readyHarness({ loadRequest = true } = {}): Promise<Harness> {
  const harness = renderGoogleAuth();
  await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('anonymous'));
  if (loadRequest) await deliverGoogleRequest(harness, AUTH_REQUEST);
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
  currentRequest = null;
  renderTick = 0;
  mockLoadToken.mockResolvedValue(null);
  promptAsync.mockResolvedValue({ type: 'dismiss' });
  mockUseAuthRequest.mockImplementation((config?: { shouldAutoExchangeCode?: boolean }) => [
    currentRequest,
    providerResponse(config),
    promptAsync,
  ]);
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

/** Every result that means the user closed or abandoned the sheet themselves. */
const QUIET_RESULTS = [{ type: 'cancel' }, { type: 'dismiss' }, { type: 'locked' }];

describe('useGoogleAuth — dismissed prompt', () => {
  it.each(QUIET_RESULTS)('stays idle and silent on a $type result', async (result) => {
    const harness = await readyHarness();

    act(() => {
      harness.result.current.google.signIn();
    });
    await deliverGoogleResponse(harness, result);
    await flushMicrotasks();

    expect(mockOauthGoogle).not.toHaveBeenCalled();
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.error).toBeNull();
    expect(harness.result.current.google.submitting).toBe(false);
  });

  it.each(QUIET_RESULTS)('releases the in-flight guard after a $type result', async (result) => {
    const harness = await readyHarness();
    act(() => {
      harness.result.current.google.signIn();
    });
    await deliverGoogleResponse(harness, result);
    await flushMicrotasks();

    act(() => {
      harness.result.current.google.signIn();
    });

    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['on the auth error and the params', {}],
    ['on the params only', { withAuthError: false }],
    ['on the auth error only', { withParams: false }],
  ])('stays silent when the user declines on Google’s screen, code %s', async (_label, shape) => {
    const harness = await readyHarness();

    act(() => {
      harness.result.current.google.signIn();
    });
    await deliverGoogleResponse(harness, googleProviderError(USER_DECLINED_CODE, shape));
    await flushMicrotasks();

    expect(harness.result.current.google.error).toBeNull();
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.submitting).toBe(false);
    expect(mockOauthGoogle).not.toHaveBeenCalled();
  });
});

describe('useGoogleAuth — provider errors', () => {
  async function signInAndFail(harness: Harness, response: unknown): Promise<void> {
    act(() => {
      harness.result.current.google.signIn();
    });
    await deliverGoogleResponse(harness, response);
    await flushMicrotasks();
  }

  it('surfaces the provider-error copy when Google returns redirect_uri_mismatch', async () => {
    const harness = await readyHarness();

    await signInAndFail(harness, googleProviderError('redirect_uri_mismatch'));

    expect(harness.result.current.google.error).toBe(GOOGLE_PROVIDER_ERROR_COPY);
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.submitting).toBe(false);
    expect(mockOauthGoogle).not.toHaveBeenCalled();
    expect(harness.result.current.auth.authStatus).toBe('anonymous');
  });

  it.each([
    ['invalid_client'],
    ['unauthorized_client'],
    ['server_error'],
    ['temporarily_unavailable'],
    ['state_mismatch'],
  ])('surfaces the provider-error copy for %s', async (code) => {
    const harness = await readyHarness();

    await signInAndFail(harness, googleProviderError(code));

    expect(harness.result.current.google.error).toBe(GOOGLE_PROVIDER_ERROR_COPY);
    expect(harness.result.current.google.submitting).toBe(false);
    expect(mockOauthGoogle).not.toHaveBeenCalled();
  });

  it('classifies a legacy result by params.error when the auth error is null', async () => {
    const harness = await readyHarness();

    await signInAndFail(
      harness,
      googleProviderError('redirect_uri_mismatch', { withAuthError: false }),
    );

    expect(harness.result.current.google.error).toBe(GOOGLE_PROVIDER_ERROR_COPY);
  });

  it('never stays silent about an error result that carries no code at all', async () => {
    const harness = await readyHarness();

    await signInAndFail(harness, googleProviderError(null));

    expect(harness.result.current.google.error).toBe(GOOGLE_PROVIDER_ERROR_COPY);
  });

  it('never exchanges an error redirect, even one that happens to carry an id token', async () => {
    const harness = await readyHarness();
    const failure = googleProviderError('server_error');

    await signInAndFail(harness, { ...failure, params: { ...failure.params, id_token: ID_TOKEN } });

    expect(mockOauthGoogle).not.toHaveBeenCalled();
    expect(harness.result.current.google.error).toBe(GOOGLE_PROVIDER_ERROR_COPY);
  });

  it('never shows the raw provider code or description', async () => {
    const harness = await readyHarness();

    await signInAndFail(harness, googleProviderError('redirect_uri_mismatch'));

    expect(harness.result.current.google.error).not.toContain(PROVIDER_SENTINEL);
    expect(harness.result.current.google.error).not.toContain('redirect_uri_mismatch');
    expect(JSON.stringify(harness.result.current.google)).not.toContain(PROVIDER_SENTINEL);
  });

  it('reads as finished prose with an escape and no dead end', () => {
    expect(GOOGLE_PROVIDER_ERROR_COPY).toMatch(/[.!?]$/);
    expect(GOOGLE_PROVIDER_ERROR_COPY).toMatch(/email/);
    expect(GOOGLE_PROVIDER_ERROR_COPY).not.toMatch(/support|you entered|invalid/i);
  });

  it('releases the in-flight guard so the user can try again', async () => {
    const harness = await readyHarness();
    await signInAndFail(harness, googleProviderError('server_error'));

    act(() => {
      harness.result.current.google.signIn();
    });

    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('clears the error on a fresh attempt and authenticates on a following success', async () => {
    mockOauthGoogle.mockResolvedValue({ token: SESSION_JWT, user_id: 7 });
    const harness = await readyHarness();
    await signInAndFail(harness, googleProviderError('temporarily_unavailable'));
    expect(harness.result.current.google.error).toBe(GOOGLE_PROVIDER_ERROR_COPY);

    act(() => {
      harness.result.current.google.signIn();
    });
    expect(harness.result.current.google.error).toBeNull();
    await deliverGoogleResponse(harness, googleSuccess(ID_TOKEN));

    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockOauthGoogle).toHaveBeenCalledTimes(1);
    expect(mockOauthGoogle).toHaveBeenCalledWith({
      id_token: ID_TOKEN,
      timezone: DEVICE_TIMEZONE,
    });
  });
});

describe('useGoogleAuth — native code exchange', () => {
  async function signInWithCode(harness: Harness): Promise<void> {
    act(() => {
      harness.result.current.google.signIn();
    });
    await deliverGoogleResponse(harness, googleCodeSuccess());
    await flushMicrotasks();
  }

  it('releases the guard and tells the user when the code exchange is refused', async () => {
    mockExchangeCodeAsync.mockRejectedValueOnce(
      new Error('invalid_grant: SENTINEL-PROVIDER-DESCRIPTION'),
    );
    const harness = await readyHarness();

    await signInWithCode(harness);

    expect(harness.result.current.google.error).toBe(GOOGLE_PROVIDER_ERROR_COPY);
    expect(harness.result.current.google.status).toBe('idle');
    expect(harness.result.current.google.submitting).toBe(false);
    expect(mockOauthGoogle).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.result.current.google)).not.toContain(PROVIDER_SENTINEL);

    act(() => {
      harness.result.current.google.signIn();
    });
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('releases the guard when the code exchange fails on the network', async () => {
    mockExchangeCodeAsync.mockRejectedValueOnce(new TypeError('Network request failed'));
    const harness = await readyHarness();

    await signInWithCode(harness);

    expect(harness.result.current.google.error).toBe(GOOGLE_PROVIDER_ERROR_COPY);
    expect(harness.result.current.google.submitting).toBe(false);
  });

  it('trades the code with the request PKCE verifier and signs in with the id token', async () => {
    mockExchangeCodeAsync.mockResolvedValueOnce({ idToken: ID_TOKEN, accessToken: 'access' });
    mockOauthGoogle.mockResolvedValue({ token: SESSION_JWT, user_id: 7 });
    const harness = await readyHarness();

    await signInWithCode(harness);

    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockExchangeCodeAsync).toHaveBeenCalledTimes(1);
    expect(mockExchangeCodeAsync).toHaveBeenCalledWith(
      {
        clientId: AUTH_REQUEST.clientId,
        redirectUri: AUTH_REQUEST.redirectUri,
        code: AUTH_CODE,
        extraParams: { code_verifier: AUTH_REQUEST.codeVerifier },
      },
      { tokenEndpoint: GOOGLE_TOKEN_ENDPOINT },
    );
    expect(mockOauthGoogle).toHaveBeenCalledWith({ id_token: ID_TOKEN, timezone: DEVICE_TIMEZONE });
  });

  it.each([
    ['no id token', {}],
    ['an empty id token', { idToken: '' }],
  ])('surfaces the fallback copy when the exchange returns %s', async (_label, tokens) => {
    mockExchangeCodeAsync.mockResolvedValueOnce(tokens);
    const harness = await readyHarness();

    await signInWithCode(harness);

    expect(harness.result.current.google.error).toBe(GOOGLE_FALLBACK_COPY);
    expect(harness.result.current.google.submitting).toBe(false);
    expect(mockOauthGoogle).not.toHaveBeenCalled();
  });

  it('surfaces the fallback copy when a code arrives before the request has loaded', async () => {
    const harness = await readyHarness({ loadRequest: false });

    await signInWithCode(harness);

    expect(harness.result.current.google.error).toBe(GOOGLE_FALLBACK_COPY);
    expect(mockExchangeCodeAsync).not.toHaveBeenCalled();
  });

  it('trades with the request that loaded after mount, not the empty first render', async () => {
    mockExchangeCodeAsync.mockResolvedValueOnce({ idToken: ID_TOKEN });
    mockOauthGoogle.mockResolvedValue({ token: SESSION_JWT, user_id: 7 });
    const harness = await readyHarness();
    // The provider really did mount with no request, as the real one does.
    const [firstRequest] = mockUseAuthRequest.mock.results[0]?.value as [unknown];
    expect(firstRequest).toBeNull();

    await signInWithCode(harness);

    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockExchangeCodeAsync).toHaveBeenCalledWith(
      {
        clientId: AUTH_REQUEST.clientId,
        redirectUri: AUTH_REQUEST.redirectUri,
        code: AUTH_CODE,
        extraParams: { code_verifier: AUTH_REQUEST.codeVerifier },
      },
      { tokenEndpoint: GOOGLE_TOKEN_ENDPOINT },
    );
  });

  it('never spends the single-use code twice when the request is re-created mid-trade', async () => {
    const pending = deferred<{ idToken: string }>();
    mockExchangeCodeAsync.mockReturnValueOnce(pending.promise);
    mockOauthGoogle.mockResolvedValue({ token: SESSION_JWT, user_id: 7 });
    const harness = await readyHarness();
    await signInWithCode(harness);

    await deliverGoogleRequest(harness, { ...AUTH_REQUEST });
    await flushMicrotasks();

    expect(mockExchangeCodeAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ idToken: ID_TOKEN });
    });
    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockExchangeCodeAsync).toHaveBeenCalledTimes(1);
    expect(mockOauthGoogle).toHaveBeenCalledTimes(1);
    expect(mockOauthGoogle).toHaveBeenCalledWith({ id_token: ID_TOKEN, timezone: DEVICE_TIMEZONE });
  });

  it('never trades a code on web, where the redirect already carries the id token', async () => {
    mockOauthGoogle.mockResolvedValue({ token: SESSION_JWT, user_id: 7 });
    const harness = await readyHarness();

    await signInAndDeliver(harness, ID_TOKEN);

    await waitFor(() => expect(harness.result.current.auth.authStatus).toBe('authenticated'));
    expect(mockExchangeCodeAsync).not.toHaveBeenCalled();
  });

  it('drops a code exchange that settles after the screen unmounts', async () => {
    const pending = deferred<{ idToken: string }>();
    mockExchangeCodeAsync.mockReturnValueOnce(pending.promise);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await readyHarness();
    await signInWithCode(harness);

    harness.unmount();
    await act(async () => {
      pending.resolve({ idToken: ID_TOKEN });
    });

    expect(mockOauthGoogle).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('useGoogleAuth — unexpected failures', () => {
  it('surfaces a network failure without entering the license step', async () => {
    mockOauthGoogle.mockRejectedValueOnce(new TypeError('Network request failed'));
    const harness = await readyHarness();

    await signInAndDeliver(harness, ID_TOKEN);

    await waitFor(() => expect(harness.result.current.google.error).not.toBeNull());
    expect(harness.result.current.google.status).toBe('idle');
    // The exchange never reached a response, and nothing has told the client
    // the device is offline, so the copy names only that (#2661).
    expect(harness.result.current.google.error).toBe(UNREACHABLE_MESSAGE);
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
