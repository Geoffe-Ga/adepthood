/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { goalGroups, ApiError, ApiValidationError } from '../index';

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

describe('goalGroups API client', () => {
  test('goalGroups.list sends GET to /goal-groups/', async () => {
    const groups = [{ id: 1, name: 'Meditation Goals', shared_template: true, goals: [] }];
    mockFetch.mockReturnValueOnce(jsonResponse(groups));

    const result = await goalGroups.list('test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/goal-groups/');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(result).toEqual(groups);
  });

  test('goalGroups.get sends GET to /goal-groups/:id', async () => {
    const group = { id: 1, name: 'Meditation Goals', shared_template: true, goals: [] };
    mockFetch.mockReturnValueOnce(jsonResponse(group));

    const result = await goalGroups.get(1, 'test-token');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/goal-groups/1');
    expect(result).toEqual(group);
  });

  test('goalGroups.list throws ApiError on failure', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ detail: 'not_authenticated' }),
      }),
    );

    await expect(goalGroups.list('bad-token')).rejects.toThrow(ApiError);
  });

  test('goalGroups.list rejects a drifted row missing shared_template', async () => {
    const drifted = [{ id: 1, name: 'Meditation Goals', goals: [] }];
    mockFetch.mockReturnValueOnce(jsonResponse(drifted));

    await expect(goalGroups.list('test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('goalGroups.list rejects a row with a wrong-typed name', async () => {
    const drifted = [{ id: 1, name: 123, shared_template: true, goals: [] }];
    mockFetch.mockReturnValueOnce(jsonResponse(drifted));

    await expect(goalGroups.list('test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('goalGroups.get rejects a payload missing shared_template', async () => {
    const drifted = { id: 1, name: 'Meditation Goals', goals: [] };
    mockFetch.mockReturnValueOnce(jsonResponse(drifted));

    await expect(goalGroups.get(1, 'test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('goalGroups.get rejects a payload with a wrong-typed name', async () => {
    const drifted = { id: 1, name: 123, shared_template: true, goals: [] };
    mockFetch.mockReturnValueOnce(jsonResponse(drifted));

    await expect(goalGroups.get(1, 'test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
