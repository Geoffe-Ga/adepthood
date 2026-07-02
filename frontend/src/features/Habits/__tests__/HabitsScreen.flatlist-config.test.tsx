/* eslint-env jest */
// audit-render-07: the Habits FlatList must supply getItemLayout (so it can skip
// async measurement) and the per-completion missed-days scan must be gated on
// the modal being open rather than running on every render.
import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { View } from 'react-native';

import type { Habit } from '../Habits.types';
import { HabitList, missedDaysFor } from '../HabitsScreen';

// Stub the modal components — importing HabitsScreen pulls them in, and some
// carry native deps (e.g. datetimepicker) that don't load under jest.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'token' })),
}));
jest.mock('../components/AddHabitModal', () => () => null);
jest.mock('../components/GoalModal', () => () => null);
jest.mock('../components/HabitSettingsModal', () => () => null);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/StatsModal', () => () => null);

const mockCalculateMissedDays = jest.fn((_habit: unknown) => [{ date: '2026-06-01' }]);
jest.mock('../HabitUtils', () => ({
  ...(jest.requireActual('../HabitUtils') as Record<string, unknown>),
  calculateMissedDays: (habit: unknown) => mockCalculateMissedDays(habit),
}));

function makeHabit(id: number): Habit {
  return {
    id,
    name: `Habit ${id}`,
    icon: '🧪',
    stage: 'Beige',
    streak: 0,
    energy_cost: 5,
    energy_return: 7,
    start_date: new Date(2020, 0, 1),
    goals: [],
    completions: [],
    revealed: true,
  } as Habit;
}

const renderRow = ({ item }: { item: Habit }) => <View testID={`row-${item.id}`} />;

describe('Habits FlatList getItemLayout', () => {
  it('supplies getItemLayout with correct multi-column row offsets', () => {
    const habits = [1, 2, 3, 4, 5].map(makeHabit);
    const { getByTestId } = render(
      <HabitList habits={habits} columns={2} gridGutter={8} renderItem={renderRow} />,
    );

    const getItemLayout = getByTestId('habits-list').props.getItemLayout as (
      _d: unknown,
      _i: number,
    ) => { length: number; offset: number; index: number };
    expect(typeof getItemLayout).toBe('function');

    const row0 = getItemLayout(null, 0);
    const rowHeight = row0.length;
    expect(rowHeight).toBeGreaterThan(0);
    expect(row0.offset).toBe(0);
    // 2 columns: index 2 and 3 are the second row; index 4 is the third row.
    expect(getItemLayout(null, 2).offset).toBe(rowHeight);
    expect(getItemLayout(null, 3).offset).toBe(rowHeight);
    expect(getItemLayout(null, 4).offset).toBe(rowHeight * 2);
    expect(getItemLayout(null, 4).index).toBe(4);
  });
});

describe('Habits FlatList keyExtractor and column layout', () => {
  it('keys rows by id, falling back to the habit name when id is missing', () => {
    const habits = [1, 2].map(makeHabit);
    const { getByTestId } = render(
      <HabitList habits={habits} columns={1} gridGutter={8} renderItem={renderRow} />,
    );
    const keyExtractor = getByTestId('habits-list').props.keyExtractor as (_item: Habit) => string;
    expect(keyExtractor(habits[0]!)).toBe(String(habits[0]!.id));
    const noIdHabit = { ...habits[0]!, id: undefined } as unknown as Habit;
    expect(keyExtractor(noIdHabit)).toBe(noIdHabit.name);
  });

  it('omits columnWrapperStyle in a single-column layout', () => {
    const habits = [1, 2].map(makeHabit);
    const { getByTestId } = render(
      <HabitList habits={habits} columns={1} gridGutter={8} renderItem={renderRow} />,
    );
    expect(getByTestId('habits-list').props.columnWrapperStyle).toBeUndefined();
  });
});

describe('missed-days computation gating', () => {
  it('does not scan completions while the modal is closed', () => {
    mockCalculateMissedDays.mockClear();
    const result = missedDaysFor(false, makeHabit(1));
    expect(mockCalculateMissedDays).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('scans (once) and returns the value when the modal is open', () => {
    mockCalculateMissedDays.mockClear();
    const habit = makeHabit(1);
    const result = missedDaysFor(true, habit);
    expect(mockCalculateMissedDays).toHaveBeenCalledTimes(1);
    expect(mockCalculateMissedDays).toHaveBeenCalledWith(habit);
    expect(result).toEqual([{ date: '2026-06-01' }]);
  });

  it('returns [] without scanning when there is no selected habit', () => {
    mockCalculateMissedDays.mockClear();
    expect(missedDaysFor(true, null)).toEqual([]);
    expect(mockCalculateMissedDays).not.toHaveBeenCalled();
  });
});
