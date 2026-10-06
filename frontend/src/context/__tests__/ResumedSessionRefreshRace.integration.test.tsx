/**
 * A resumed session must not sign itself out by refreshing its token twice
 * (#3034).
 *
 * ``POST /auth/refresh`` revokes the token it is called with, and production
 * allows one call a minute. A cold start can ask for a refresh from three
 * places at once — the timezone backfill for a session with no cached zone,
 * the proactive refresh of a token already past its deadline, and the
 * proactive timer — while the app's first wave of reads is still in flight
 * carrying the very token being rotated. Those reads 401 the moment the server
 * revokes it, and each 401 used to run its own refresh of the now-dead token:
 * a second POST, the limiter's 429, and the session cleared to the re-auth
 * sheet.
 *
 * This is the join that only shows up with every real piece in place: the
 * real ``AuthProvider`` and the real HTTP client, against a fake server that
 * revokes on refresh and answers any second refresh with the 429 production
 * would. Every case asserts the same three things: exactly one refresh on the
 * wire, every read in the wave succeeds on the successor, and the session is
 * still signed in.
 */
/* global describe, test, expect, jest, beforeEach, afterEach */
import { readFileSync } from 'fs';
import { join } from 'path';

import { act, renderHook } from '@testing-library/react-native';
import React from 'react';

import { habits } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import * as authStorage from '@/storage/authStorage';
import { settle } from '@/testing/asyncSettle';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/storage/authStorage', () => ({
  saveToken: jest.fn(() => Promise.resolve()),
  loadToken: jest.fn(() => Promise.resolve(null)),
  clearToken: jest.fn(() => Promise.resolve()),
  markLogoutPending: jest.fn(() => Promise.resolve()),
  isLogoutPending: jest.fn(() => Promise.resolve(false)),
  clearLogoutPending: jest.fn(() => Promise.resolve()),
  saveUserTimezone: jest.fn(() => Promise.resolve()),
  loadUserTimezone: jest.fn(() => Promise.resolve(null)),
  clearUserTimezone: jest.fn(() => Promise.resolve()),
}));

const mockAuthStorage = authStorage as jest.Mocked<typeof authStorage>;

const USER_ID = 7;
const SERVER_ZONE = 'America/Los_Angeles';
const TOKEN_LIFETIME_SECONDS = 3600;
const MS_PER_SECOND = 1000;
/** Half of the lifetime: where ``refreshDeadlineMs`` puts the sliding mark. */
const HALF_LIFE_MS = (TOKEN_LIFETIME_SECONDS / 2) * MS_PER_SECOND;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A token shaped like the backend's: ``sub`` is the user id, ``iat``/``exp`` in seconds. */
function mintToken(label: string, issuedAgoSeconds = 0): string {
  const issuedAt = Math.floor(Date.now() / MS_PER_SECOND) - issuedAgoSeconds;
  const claims = {
    sub: String(USER_ID),
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    jti: label,
  };
  return `${base64Url('{"alg":"HS256","typ":"JWT"}')}.${base64Url(JSON.stringify(claims))}.sig`;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
}

function reply(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= HTTP_OK && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

/**
 * The server side of the race: a refresh revokes its token the instant it
 * arrives, then answers only when the test says so; a second refresh is the
 * limiter's 429; a read 401s for a revoked bearer.
 */
function installServer() {
  const state = {
    refreshCalls: 0,
    rateLimited: 0,
    revoked: new Set<string>(),
    successor: '',
    release: (): void => {},
  };
  const fetchMock = jest.fn((url: string, init?: RequestInit): Promise<FakeResponse> => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const bearer = authorization?.replace('Bearer ', '') ?? null;
    if (url.endsWith('/auth/refresh')) {
      state.refreshCalls += 1;
      if (state.refreshCalls > 1) {
        state.rateLimited += 1;
        return Promise.resolve(reply(HTTP_TOO_MANY_REQUESTS, { detail: 'rate_limited' }));
      }
      if (bearer !== null) state.revoked.add(bearer);
      state.successor = mintToken('successor');
      return new Promise((resolve) => {
        state.release = () =>
          resolve(
            reply(HTTP_OK, { token: state.successor, user_id: USER_ID, timezone: SERVER_ZONE }),
          );
      });
    }
    if (bearer === null || state.revoked.has(bearer)) {
      return Promise.resolve(reply(HTTP_UNAUTHORIZED, { detail: 'unauthorized' }));
    }
    return Promise.resolve(reply(HTTP_OK, []));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return state;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

interface ResumeOptions {
  /** How long ago the stored token was issued; past the half-life makes it due at mount. */
  issuedAgoSeconds: number;
  /** The device's cached zone; ``null`` is an install that never cached one. */
  cachedZone: string | null;
  /** Advance the clock to the proactive timer's deadline before the wave. */
  waitForTimer?: boolean;
  waveSize?: number;
}

const DEFAULT_WAVE_SIZE = 3;

/**
 * Resume a stored session, let whichever refresh the resume triggers reach
 * the server, send the app's first wave of reads while it is in flight, then
 * let the refresh answer.
 */
async function resumeWithFirstWave(options: ResumeOptions) {
  const server = installServer();
  const stored = mintToken('stored', options.issuedAgoSeconds);
  mockAuthStorage.loadToken.mockResolvedValue(stored);
  mockAuthStorage.loadUserTimezone.mockResolvedValue(options.cachedZone);

  const { result } = renderHook(() => useAuth(), { wrapper });
  await settle();
  expect(result.current.authStatus).toBe('authenticated');
  if (options.waitForTimer === true) {
    expect(server.refreshCalls).toBe(0);
    await act(async () => {
      jest.advanceTimersByTime(HALF_LIFE_MS);
    });
  }
  // Exactly one refresh is on the wire before the wave begins.
  expect(server.refreshCalls).toBe(1);

  // Most reads take the session token from the client; many stores read it
  // from the auth context and pass it explicitly. Both kinds are in the wave.
  const wave = [
    ...Array.from({ length: options.waveSize ?? DEFAULT_WAVE_SIZE }, () => habits.list()),
    habits.list(result.current.token ?? undefined),
  ];
  await settle(); // every read 401s on the revoked token while the refresh is pending
  let outcomes: PromiseSettledResult<unknown>[] = [];
  await act(async () => {
    server.release();
    outcomes = await Promise.allSettled(wave);
  });
  await settle();
  return { server, result, outcomes, stored };
}

function expectSurvived(run: Awaited<ReturnType<typeof resumeWithFirstWave>>): void {
  expect(run.server.refreshCalls).toBe(1);
  expect(run.server.rateLimited).toBe(0);
  expect(run.outcomes.map((o) => o.status)).toEqual(run.outcomes.map(() => 'fulfilled'));
  expect(run.result.current.authStatus).toBe('authenticated');
  expect(run.result.current.token).toBe(run.server.successor);
  expect(mockAuthStorage.clearToken).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a resumed session refreshes its token exactly once (#3034)', () => {
  test('the timezone backfill racing the first wave', async () => {
    const run = await resumeWithFirstWave({ issuedAgoSeconds: 0, cachedZone: null });

    expectSurvived(run);
    expect(run.result.current.userTimezone).toBe(SERVER_ZONE);
    // The backfill's own apply and the client's rotation publish are the same
    // token behind the same identity guard: idempotent, never a third value.
    const saved = mockAuthStorage.saveToken.mock.calls.map(([token]) => token);
    expect(saved.length).toBeGreaterThan(0);
    expect(new Set(saved)).toEqual(new Set([run.server.successor]));
  });

  test('the proactive refresh of a token already due at mount', async () => {
    const run = await resumeWithFirstWave({
      issuedAgoSeconds: TOKEN_LIFETIME_SECONDS / 2 + 60,
      cachedZone: SERVER_ZONE,
    });

    expectSurvived(run);
  });

  test('the proactive refresh of a due token with no cached zone either', async () => {
    const run = await resumeWithFirstWave({
      issuedAgoSeconds: TOKEN_LIFETIME_SECONDS / 2 + 60,
      cachedZone: null,
    });

    expectSurvived(run);
    expect(run.result.current.userTimezone).toBe(SERVER_ZONE);
  });

  test('the proactive timer firing at the half-life mark', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const run = await resumeWithFirstWave({
      issuedAgoSeconds: 0,
      cachedZone: SERVER_ZONE,
      waitForTimer: true,
    });

    expectSurvived(run);
  });
});

describe('every refresh entry point goes through the session coalescer (#3034)', () => {
  const source = readFileSync(join(__dirname, '..', 'AuthContext.tsx'), 'utf8');

  test('AuthContext never calls the raw refresh endpoint', () => {
    expect(source).not.toMatch(/\bauth(Api)?\.refresh\(/);
  });

  test('AuthContext refreshes through refreshSessionToken', () => {
    expect(source).toMatch(/\brefreshSessionToken\(/);
  });
});
