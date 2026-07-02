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

const userPractice = {
  id: 3,
  practice_id: 7,
  stage_number: 2,
  start_date: '2026-01-01',
  end_date: null,
};

describe('userPractices.create', () => {
  test('POSTs the payload and parses a valid UserPractice response', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(userPractice, 201));

    const result = await userPractices.create({ practice_id: 7, stage_number: 2 });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/user-practices/');
    expect(init.method).toBe('POST');
    expect(result).toEqual(userPractice);
  });

  test('rejects a drifted response missing start_date', async () => {
    const drifted = { ...userPractice, start_date: undefined };
    mockFetch.mockReturnValueOnce(jsonResponse(drifted, 201));

    await expect(userPractices.create({ practice_id: 7, stage_number: 2 })).rejects.toBeInstanceOf(
      ApiValidationError,
    );
  });

  test('rejects a response with a non-ISO start_date', async () => {
    const drifted = { ...userPractice, start_date: 'not-a-date' };
    mockFetch.mockReturnValueOnce(jsonResponse(drifted, 201));

    await expect(userPractices.create({ practice_id: 7, stage_number: 2 })).rejects.toBeInstanceOf(
      ApiValidationError,
    );
  });
});

describe('userPractices.list', () => {
  test('GETs /user-practices/ and parses a valid array', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([userPractice]));

    const result = await userPractices.list('test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/user-practices/');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(result).toEqual([userPractice]);
  });

  test('rejects a drifted row with a non-ISO start_date', async () => {
    const drifted = [{ ...userPractice, start_date: 'not-a-date' }];
    mockFetch.mockReturnValueOnce(jsonResponse(drifted));

    await expect(userPractices.list('test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
