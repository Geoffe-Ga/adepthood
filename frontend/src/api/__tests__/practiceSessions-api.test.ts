/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { practiceSessions, ApiValidationError } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

const session = {
  id: 9,
  user_practice_id: 3,
  duration_minutes: 10,
  timestamp: '2026-03-01T10:30:00Z',
  reflection: null,
};

const createPayload = {
  user_practice_id: 3,
  started_at: '2026-03-01T10:20:00Z',
  ended_at: '2026-03-01T10:30:00Z',
};

describe('practiceSessions.create', () => {
  test('POSTs the payload and parses a valid PracticeSessionResponse', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(session, 201));

    const result = await practiceSessions.create(createPayload);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-sessions/');
    expect(init.method).toBe('POST');
    expect(result).toEqual(session);
  });

  test('rejects a response with a non-ISO timestamp', async () => {
    const drifted = { ...session, timestamp: 'oops' };
    mockFetch.mockReturnValueOnce(jsonResponse(drifted, 201));

    await expect(practiceSessions.create(createPayload)).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a response missing user_practice_id', async () => {
    const drifted = { ...session, user_practice_id: undefined };
    mockFetch.mockReturnValueOnce(jsonResponse(drifted, 201));

    await expect(practiceSessions.create(createPayload)).rejects.toBeInstanceOf(ApiValidationError);
  });
});
