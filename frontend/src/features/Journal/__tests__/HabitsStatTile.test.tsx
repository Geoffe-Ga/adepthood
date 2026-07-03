/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: 'UTC' }),
}));

const mockLoadHabits = jest.fn();
jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: {
    loadHabits: (...args: unknown[]) => mockLoadHabits(...args),
  },
}));

import HabitsStatTile from '../HabitsStatTile';

import type { Habit } from '@/features/Habits/Habits.types';
import { useHabitStore } from '@/store/useHabitStore';

const DAY_MS = 24 * 60 * 60 * 1000;

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Test Habit',
  icon: 'leaf',
  streak: 0,
  energy_cost: 5,
  energy_return: 5,
  start_date: new Date('2020-01-01T00:00:00Z'),
  goals: [],
  completions: [],
  revealed: true,
  ...overrides,
});

beforeEach(() => {
  mockNavigate.mockClear();
  mockLoadHabits.mockClear();
  useHabitStore.setState({
    loading: false,
    habits: [],
    habitsById: {},
    habitOrder: [],
    error: null,
  });
});

describe('HabitsStatTile', () => {
  it('shows the skeleton while loading with no habits yet', () => {
    useHabitStore.setState({ loading: true, habits: [] });
    const { getByTestId } = render(<HabitsStatTile />);
    expect(getByTestId('journal-habits-tile-skeleton')).toBeTruthy();
    const label = getByTestId('journal-habits-tile').props.accessibilityLabel as string;
    expect(label).toBe("Today's habits, loading. Open habits");
  });

  it('shows the no-habits stat and cue when the user has no habits', () => {
    useHabitStore.setState({ loading: false, habits: [] });
    const { getByText, getByTestId } = render(<HabitsStatTile />);
    expect(getByText('No habits yet')).toBeTruthy();
    expect(getByText('Add a habit →')).toBeTruthy();
    const label = getByTestId('journal-habits-tile').props.accessibilityLabel as string;
    expect(label).toBe("Today's habits, no habits yet. Add a habit");
  });

  it('navigates to Habits when the empty-state tile is pressed', () => {
    useHabitStore.setState({ loading: false, habits: [] });
    const { getByTestId } = render(<HabitsStatTile />);
    fireEvent.press(getByTestId('journal-habits-tile'));
    expect(mockNavigate).toHaveBeenCalledWith('Habits');
  });

  it('shows "Unlocks soon" when every habit is still locked', () => {
    const lockedOne = makeHabit({
      id: 2,
      revealed: false,
      start_date: new Date(Date.now() + 7 * DAY_MS),
    });
    const lockedTwo = makeHabit({
      id: 3,
      revealed: false,
      start_date: new Date(Date.now() + 14 * DAY_MS),
    });
    useHabitStore.setState({ loading: false, habits: [lockedOne, lockedTwo] });
    const { getByText, getByTestId } = render(<HabitsStatTile />);
    expect(getByText('Unlocks soon')).toBeTruthy();
    const label = getByTestId('journal-habits-tile').props.accessibilityLabel as string;
    expect(label).toBe("Today's habits, unlocks soon. Open habits");
  });

  it('shows "1/2 done" when one of two unlocked habits was completed today', () => {
    const done = makeHabit({
      id: 4,
      revealed: true,
      completions: [{ id: 'c1', timestamp: new Date(), completed_units: 1 }],
    });
    const notDone = makeHabit({ id: 5, revealed: true, completions: [] });
    useHabitStore.setState({ loading: false, habits: [done, notDone] });
    const { getByText, getByTestId } = render(<HabitsStatTile />);
    expect(getByText('1/2 done')).toBeTruthy();
    const label = getByTestId('journal-habits-tile').props.accessibilityLabel as string;
    expect(label).toContain('1 of 2 done');
  });

  it('calls habitManager.loadHabits with the user timezone on mount', () => {
    useHabitStore.setState({ loading: false, habits: [] });
    render(<HabitsStatTile />);
    expect(mockLoadHabits).toHaveBeenCalledWith('UTC');
  });
});
