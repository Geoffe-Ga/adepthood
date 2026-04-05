/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { goalGroups, ApiError } from '../index';

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

  test('goalGroups.create sends POST with payload', async () => {
    const created = { id: 2, name: 'Custom', shared_template: false, goals: [] };
    mockFetch.mockReturnValueOnce(jsonResponse(created, 201));

    const result = await goalGroups.create({ name: 'Custom', icon: '🎯' }, 'test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/goal-groups/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ name: 'Custom', icon: '🎯' });
    expect(result).toEqual(created);
  });

  test('goalGroups.update sends PUT with payload', async () => {
    const updated = { id: 1, name: 'Updated', shared_template: false, goals: [] };
    mockFetch.mockReturnValueOnce(jsonResponse(updated));

    const result = await goalGroups.update(1, { name: 'Updated' }, 'test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/goal-groups/1');
    expect(init.method).toBe('PUT');
    expect(result).toEqual(updated);
  });

  test('goalGroups.delete sends DELETE request', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) }),
    );

    await goalGroups.delete(1, 'test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/goal-groups/1');
    expect(init.method).toBe('DELETE');
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
});
