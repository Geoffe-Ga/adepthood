/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, IDEMPOTENCY_KEY_HEADER, invitations } from '../index';
import type { Invitation } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: 7,
    target_type: 'habit',
    target_id: 42,
    kind: 'consistency',
    created_at: '2026-06-24T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('invitations.list', () => {
  test('GETs /invitations and resolves to the parsed bare array', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([invitation(), invitation({ id: 8 })]));
    const result = await invitations.list('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/invitations');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result.map((r) => r.id)).toEqual([7, 8]);
  });

  test('surfaces a 401 as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    const err = await invitations.list('tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });
});

describe('invitations.dismiss', () => {
  test('POSTs /invitations/{id}/dismiss with a deterministic idempotency key', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(null, 204));
    await invitations.dismiss(7, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/invitations/7/dismiss');
    expect(init.method).toBe('POST');
    expect(init.headers[IDEMPOTENCY_KEY_HEADER]).toBe('dismiss-invitation:7');
  });

  test('idempotency key is deterministic: same id always yields the same key', async () => {
    mockFetch
      .mockReturnValueOnce(jsonResponse(null, 204))
      .mockReturnValueOnce(jsonResponse(null, 204));
    await invitations.dismiss(99, 'tok');
    await invitations.dismiss(99, 'tok');
    const calls = mockFetch.mock.calls as [string, { headers: Record<string, string> }][];
    const keys = calls.map((c) => c[1].headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys).toEqual(['dismiss-invitation:99', 'dismiss-invitation:99']);
  });
});
