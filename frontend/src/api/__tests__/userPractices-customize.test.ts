/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { userPractices, ApiValidationError } from '../index';

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

describe('userPractices.customize', () => {
  test('sends PATCH to /user-practices/{id}/customize with the override payload', async () => {
    const updated = {
      id: 17,
      user_id: 1,
      practice_id: 9,
      stage_number: 3,
      start_date: '2026-05-01',
      end_date: null,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(updated));

    const result = await userPractices.customize(
      17,
      {
        custom_name: 'My Sit',
        mode_config_override: { mode: 'meditation_timer', duration_minutes: 15 },
      },
      'token-xyz',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/user-practices/17/customize');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      custom_name: 'My Sit',
      mode_config_override: { mode: 'meditation_timer', duration_minutes: 15 },
    });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-xyz' });
    expect(result).toEqual(updated);
  });

  test('passes null overrides to clear server-side state', async () => {
    const updated = {
      id: 42,
      practice_id: 9,
      stage_number: 3,
      start_date: '2026-05-01',
      end_date: null,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(updated));
    await userPractices.customize(42, { custom_name: null, mode_config_override: null });
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      custom_name: null,
      mode_config_override: null,
    });
  });

  test('accepts a valid UserPractice response', async () => {
    const updated = {
      id: 17,
      practice_id: 9,
      stage_number: 3,
      start_date: '2026-05-01',
      end_date: null,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(updated));

    const result = await userPractices.customize(17, {
      custom_name: 'My Sit',
      mode_config_override: null,
    });

    expect(result).toEqual(updated);
  });

  test('rejects a drifted response with a non-ISO start_date', async () => {
    const drifted = {
      id: 17,
      practice_id: 9,
      stage_number: 3,
      start_date: 'not-a-date',
      end_date: null,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(drifted));

    await expect(
      userPractices.customize(17, { custom_name: 'My Sit', mode_config_override: null }),
    ).rejects.toBeInstanceOf(ApiValidationError);
  });
});
