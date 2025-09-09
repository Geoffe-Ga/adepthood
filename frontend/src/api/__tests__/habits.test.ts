import { describe, it, expect, jest, beforeEach } from '@jest/globals';

import type { Habit } from '../../features/Habits/Habits.types';
import { logCompletion } from '../habits';

let fetchMock: jest.MockedFunction<typeof fetch>;

describe('logCompletion', () => {
  beforeEach(() => {
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = fetchMock;
  });

  it('posts completion and returns updated habit', async () => {
    const updatedHabit: Habit = {
      id: 1,
      stage: 'Beige',
      name: 'Test',
      icon: '🔥',
      streak: 1,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: [],
      completions: [],
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => updatedHabit,
    } as unknown as Response);

    const result = await logCompletion('http://localhost:8000', 1, 2);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/v1/habits/1/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed_units: 2 }),
    });
    expect(result).toEqual(updatedHabit);
  });

  it('throws on failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    await expect(logCompletion('http://localhost:8000', 1, 1)).rejects.toThrow(
      'Request failed with status 500',
    );
  });
});
