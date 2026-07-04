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

const mockLoadStages = jest.fn();
jest.mock('@/features/Map/services/stageService', () => ({
  stageService: {
    loadStages: (...args: unknown[]) => mockLoadStages(...args),
  },
}));

import HabitsStatTile, { describeHabits } from '../HabitsStatTile';

import type { Habit } from '@/features/Habits/Habits.types';
import type { StageData } from '@/features/Map/stageData';
import { useHabitStore } from '@/store/useHabitStore';
import { useStageStore } from '@/store/useStageStore';

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

const makeStage = (stageNumber: number): StageData => ({
  id: stageNumber,
  title: `Stage ${stageNumber}`,
  subtitle: `Subtitle ${stageNumber}`,
  stageNumber,
  progress: 0,
  color: '#aaa',
  isUnlocked: true,
  category: '',
  aspect: '',
  spiralDynamicsColor: '',
  growingUpStage: '',
  divineGenderPolarity: '',
  relationshipToFreeWill: '',
  freeWillDescription: '',
  overviewUrl: '',
});

beforeEach(() => {
  mockNavigate.mockClear();
  mockLoadHabits.mockClear();
  mockLoadStages.mockClear();
  useHabitStore.setState({
    loading: false,
    habits: [],
    habitsById: {},
    habitOrder: [],
    error: null,
  });
  // Seeded so the (currently still present) stage-store gate never blocks
  // these tests on its own skeleton — the denominator itself must not
  // depend on this value.
  useStageStore.setState({
    stages: [makeStage(1), makeStage(2), makeStage(3)],
    currentStage: 3,
    loading: false,
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

  it('calls habitManager.loadHabits with the user timezone on mount', () => {
    useHabitStore.setState({ loading: false, habits: [] });
    render(<HabitsStatTile />);
    expect(mockLoadHabits).toHaveBeenCalledWith('UTC');
  });

  it('counts a manually-unlocked habit toward the denominator regardless of its stage', () => {
    // Blue is well above currentStage 1 -- under the old stage-gated model
    // this habit would stay excluded from the denominator. Under the new
    // model only `revealed` decides, so it counts.
    const habits = [
      makeHabit({
        id: 500,
        stage: 'Blue',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
    ];
    useHabitStore.setState({ loading: false, habits });
    useStageStore.setState({ currentStage: 1 });
    const { getByText } = render(<HabitsStatTile />);
    expect(getByText('0/1 done')).toBeTruthy();
  });

  it('excludes a locked (revealed: false) habit from the denominator even at a low stage', () => {
    // Beige is the very first stage -- under the old stage-gated model this
    // habit would already count regardless of `revealed`. The new model
    // requires an explicit manual unlock.
    const habits = [
      makeHabit({
        id: 501,
        stage: 'Beige',
        revealed: false,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
    ];
    useHabitStore.setState({ loading: false, habits });
    useStageStore.setState({ currentStage: 5 });
    const { queryByText } = render(<HabitsStatTile />);
    expect(queryByText(/\/1 done/)).toBeNull();
  });

  it('counts done-today progress only against manually-unlocked habits', () => {
    const habits = [
      makeHabit({
        id: 510,
        stage: 'Beige',
        revealed: true,
        completions: [{ id: 'c1', timestamp: new Date(), completed_units: 1 }],
      }),
      makeHabit({ id: 511, stage: 'Purple', revealed: false }),
    ];
    useHabitStore.setState({ loading: false, habits });
    const { getByText } = render(<HabitsStatTile />);
    expect(getByText('1/1 done')).toBeTruthy();
  });

  it('shows a manual-unlock invitation instead of "Unlocks soon" for a zero-unlocked corpus', () => {
    // Both habits sit at the highest stages so the OLD stage-gated model
    // would also report zero-unlocked here -- isolating this test to the
    // copy itself, not the count.
    const habits = [
      makeHabit({ id: 520, stage: 'Ultraviolet', revealed: false }),
      makeHabit({ id: 521, stage: 'Clear Light', revealed: false }),
    ];
    useHabitStore.setState({ loading: false, habits });
    useStageStore.setState({ currentStage: 1 });
    const { getByText, queryByText } = render(<HabitsStatTile />);
    expect(queryByText('Unlocks soon')).toBeNull();
    expect(getByText('Unlock a habit to begin')).toBeTruthy();
  });
});

describe('describeHabits', () => {
  it('returns the manual-unlock invitation stat and cue when there are habits but none unlocked yet', () => {
    const result = describeHabits(false, 2, 0, 0);
    expect(result.stat).toBe('Unlock a habit to begin');
    expect(result.cue).toBe('Open habits →');
    expect(result.accessibilityLabel).toBe("Today's habits, unlock a habit to begin. Open habits");
  });
});
