/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { habits, goalCompletions, ApiError } from '../index';

// Mock global fetch
const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

// Silence the API_BASE_URL import — just needs a string value
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

describe('habits API client', () => {
  test('habits.create sends POST with habit payload', async () => {
    const created = { id: 1, name: 'Water', icon: '💧' };
    mockFetch.mockReturnValueOnce(jsonResponse(created));

    const result = await habits.create(
      {
        name: 'Water',
        icon: '💧',
        start_date: '2024-01-01',
        energy_cost: 1,
        energy_return: 2,
      },
      'test-token',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/habits');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ name: 'Water', icon: '💧' });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(result).toEqual(created);
  });

  test('habits.update sends PUT with habit payload', async () => {
    const updated = { id: 1, name: 'Water Updated', icon: '💧' };
    mockFetch.mockReturnValueOnce(jsonResponse(updated));

    const result = await habits.update(
      1,
      {
        name: 'Water Updated',
        icon: '💧',
        start_date: '2024-01-01',
        energy_cost: 1,
        energy_return: 2,
      },
      'test-token',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/habits/1');
    expect(init.method).toBe('PUT');
    expect(result).toEqual(updated);
  });

  test('habits.delete sends DELETE request', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) }),
    );

    await habits.delete(1, 'test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/habits/1');
    expect(init.method).toBe('DELETE');
  });
});

describe('goalCompletions API client', () => {
  test('goalCompletions.create sends POST with goal_id and did_complete', async () => {
    const result = { streak: 3, milestones: [], reason_code: 'streak_incremented' };
    mockFetch.mockReturnValueOnce(jsonResponse(result));

    const response = await goalCompletions.create(
      { goal_id: 42, did_complete: true },
      'test-token',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/goal_completions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ goal_id: 42, did_complete: true });
    expect(response).toEqual(result);
  });

  test('goalCompletions.create throws ApiError on failure', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ detail: 'goal_not_found' }),
      }),
    );

    await expect(goalCompletions.create({ goal_id: 999 }, 'test-token')).rejects.toThrow(ApiError);
  });
});
