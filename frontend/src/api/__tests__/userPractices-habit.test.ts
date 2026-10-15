import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ApiValidationError, userPractices } from '../index';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

const adoption = {
  id: 17,
  practice_id: 9,
  stage_number: 3,
  start_date: '2026-10-14',
  end_date: null,
  habit_id: 25,
};

function reply(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('userPractices.linkHabit', () => {
  it('patches the owned adoption route and validates the returned link', async () => {
    mockFetch.mockResolvedValueOnce(reply(adoption));
    await expect(userPractices.linkHabit(17, 25, 'test-token')).resolves.toEqual(adoption);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test/user-practices/17/habit',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ habit_id: 25 }),
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('clears with an explicit null rather than omitting the field', async () => {
    mockFetch.mockResolvedValueOnce(reply({ ...adoption, habit_id: null }));
    await expect(userPractices.linkHabit(17, null)).resolves.toMatchObject({ habit_id: null });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test/user-practices/17/habit',
      expect.objectContaining({ body: JSON.stringify({ habit_id: null }) }),
    );
  });

  it('rejects a malformed link response', async () => {
    mockFetch.mockResolvedValueOnce(reply({ ...adoption, habit_id: '25' }));
    await expect(userPractices.linkHabit(17, 25)).rejects.toBeInstanceOf(ApiValidationError);
  });

  it('preserves a server refusal without pretending the link was saved', async () => {
    mockFetch.mockResolvedValueOnce(reply({ detail: 'forbidden' }, 403));
    await expect(userPractices.linkHabit(17, 25)).rejects.toMatchObject({ status: 403 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
