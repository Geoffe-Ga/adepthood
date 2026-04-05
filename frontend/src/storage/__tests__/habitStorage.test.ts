/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Habit } from '../../features/Habits/Habits.types';
import { saveHabits, loadHabits, clearHabits } from '../habitStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const sampleHabit: Habit = {
  id: 1,
  stage: 'Beige',
  name: 'Meditate',
  icon: '🧘',
  streak: 5,
  energy_cost: 2,
  energy_return: 4,
  start_date: new Date('2024-06-01T00:00:00.000Z'),
  goals: [
    {
      id: 1,
      title: 'Low goal',
      tier: 'low',
      target: 10,
      target_unit: 'minutes',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ],
  completions: [
    {
      id: 'c-1',
      timestamp: new Date('2024-06-10T08:30:00.000Z'),
      completed_units: 15,
    },
  ],
  last_completion_date: new Date('2024-06-10T08:30:00.000Z'),
  revealed: true,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('habitStorage', () => {
  describe('saveHabits', () => {
    test('serializes habits and stores to AsyncStorage', async () => {
      await saveHabits([sampleHabit]);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/habits',
        expect.any(String),
      );

      // Verify the stored value is valid JSON
      const stored = mockAsyncStorage.setItem.mock.calls[0]![1] as string;
      const parsed = JSON.parse(stored);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('Meditate');
    });

    test('serializes Date fields as ISO strings', async () => {
      await saveHabits([sampleHabit]);

      const stored = mockAsyncStorage.setItem.mock.calls[0]![1] as string;
      const parsed = JSON.parse(stored);
      expect(parsed[0].start_date).toBe('2024-06-01T00:00:00.000Z');
      expect(parsed[0].last_completion_date).toBe('2024-06-10T08:30:00.000Z');
      expect(parsed[0].completions[0].timestamp).toBe('2024-06-10T08:30:00.000Z');
    });
  });

  describe('loadHabits', () => {
    test('returns null when no data stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);

      const result = await loadHabits();
      expect(result).toBeNull();
    });

    test('deserializes habits and rehydrates Date fields', async () => {
      const stored = JSON.stringify([sampleHabit]);
      mockAsyncStorage.getItem.mockResolvedValueOnce(stored);

      const result = await loadHabits();
      expect(result).toHaveLength(1);

      const habit = result![0]!;
      expect(habit.name).toBe('Meditate');
      expect(habit.start_date).toBeInstanceOf(Date);
      expect(habit.start_date.toISOString()).toBe('2024-06-01T00:00:00.000Z');
      expect(habit.last_completion_date).toBeInstanceOf(Date);
      expect(habit.completions![0]!.timestamp).toBeInstanceOf(Date);
    });

    test('handles habits without optional Date fields', async () => {
      const minimal: Habit = {
        id: 2,
        stage: 'Red',
        name: 'Run',
        icon: '🏃',
        streak: 0,
        energy_cost: 3,
        energy_return: 5,
        start_date: new Date('2024-07-01T00:00:00.000Z'),
        goals: [],
      };
      mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify([minimal]));

      const result = await loadHabits();
      expect(result).toHaveLength(1);
      expect(result![0]!.start_date).toBeInstanceOf(Date);
      expect(result![0]!.last_completion_date).toBeUndefined();
      expect(result![0]!.completions).toBeUndefined();
    });

    test('returns null on corrupted data', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('not valid json{{{');

      const result = await loadHabits();
      expect(result).toBeNull();
    });
  });

  describe('clearHabits', () => {
    test('removes habits from AsyncStorage', async () => {
      await clearHabits();
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/habits');
    });
  });
});
