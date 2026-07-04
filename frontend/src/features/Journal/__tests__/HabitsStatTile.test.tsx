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

// Ascending Spiral-Dynamics stages so each habit's own stage (not its list
// position) drives its unlock threshold — see isHabitUnlockedAtStage.
const STAGES = ['Beige', 'Purple', 'Red', 'Blue', 'Orange', 'Green', 'Yellow'] as const;

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

  it('anchors the denominator to currentStage, not the raw habit count', () => {
    const habits = Array.from({ length: 7 }, (_, i) =>
      makeHabit({
        id: 100 + i,
        stage: STAGES[i],
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
    );
    useHabitStore.setState({ loading: false, habits });
    useStageStore.setState({ currentStage: 3 });
    const { getByText } = render(<HabitsStatTile />);
    expect(getByText('0/3 done')).toBeTruthy();
  });

  it('shows "0/1 done" at stage 1 Beige with a single habit', () => {
    const habits = [
      makeHabit({
        id: 200,
        stage: 'Beige',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      makeHabit({
        id: 201,
        stage: 'Purple',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      makeHabit({
        id: 202,
        stage: 'Red',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
    ];
    useHabitStore.setState({ loading: false, habits });
    useStageStore.setState({ currentStage: 1 });
    const { getByText } = render(<HabitsStatTile />);
    expect(getByText('0/1 done')).toBeTruthy();
  });

  it('shows "1/1 done" at stage 1 once the first habit is completed today', () => {
    const habits = [
      makeHabit({
        id: 210,
        stage: 'Beige',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
        completions: [{ id: 'c1', timestamp: new Date(), completed_units: 1 }],
      }),
      makeHabit({
        id: 211,
        stage: 'Purple',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      makeHabit({
        id: 212,
        stage: 'Red',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
    ];
    useHabitStore.setState({ loading: false, habits });
    useStageStore.setState({ currentStage: 1 });
    const { getByText } = render(<HabitsStatTile />);
    expect(getByText('1/1 done')).toBeTruthy();
  });

  it('never counts a locked habit with a past start_date toward the denominator', () => {
    const habits = [
      makeHabit({
        id: 220,
        stage: 'Beige',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      makeHabit({
        id: 221,
        stage: 'Purple',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      makeHabit({
        id: 222,
        stage: 'Red',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      // Blue sits above currentStage 3, so a past start_date can't unlock it.
      makeHabit({
        id: 223,
        stage: 'Blue',
        revealed: false,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
    ];
    useHabitStore.setState({ loading: false, habits });
    useStageStore.setState({ currentStage: 3 });
    const { getByText } = render(<HabitsStatTile />);
    expect(getByText('0/3 done')).toBeTruthy();
  });

  it('counts an early-unlocked habit at a high stage toward the denominator', () => {
    const habits = [
      makeHabit({
        id: 230,
        stage: 'Beige',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      makeHabit({
        id: 231,
        stage: 'Purple',
        revealed: false,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      makeHabit({
        id: 232,
        stage: 'Red',
        revealed: false,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      // Blue is above currentStage 1, so only its early-unlock reveal counts it.
      makeHabit({
        id: 233,
        stage: 'Blue',
        revealed: true,
        start_date: new Date(Date.now() + 30 * DAY_MS),
      }),
    ];
    useHabitStore.setState({ loading: false, habits });
    useStageStore.setState({ currentStage: 1 });
    const { getByText } = render(<HabitsStatTile />);
    expect(getByText('0/2 done')).toBeTruthy();
  });

  it('shows the skeleton and self-hydrates stages on a cold entry with no stages loaded yet', () => {
    useHabitStore.setState({ loading: false, habits: [makeHabit({ id: 300 })] });
    useStageStore.setState({ stages: [], currentStage: 1, loading: false, error: null });
    const { getByTestId } = render(<HabitsStatTile />);
    expect(getByTestId('journal-habits-tile-skeleton')).toBeTruthy();
    expect(mockLoadStages).toHaveBeenCalledTimes(1);
  });

  it('falls back to currentStage 1 (ignoring a stale store value) and renders a determinate stat when stage loading errored', () => {
    const habits = [
      makeHabit({
        id: 310,
        stage: 'Beige',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
        completions: [{ id: 'c1', timestamp: new Date(), completed_units: 1 }],
      }),
      makeHabit({
        id: 311,
        stage: 'Purple',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      makeHabit({
        id: 312,
        stage: 'Red',
        revealed: true,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
    ];
    useHabitStore.setState({ loading: false, habits });
    // currentStage 5 is a stale value from a prior session; the error means it must not be trusted.
    useStageStore.setState({ stages: [], currentStage: 5, loading: false, error: 'boom' });
    const { getByText, queryByTestId } = render(<HabitsStatTile />);
    expect(getByText('1/1 done')).toBeTruthy();
    expect(queryByTestId('journal-habits-tile-skeleton')).toBeNull();
  });
});

describe('describeHabits', () => {
  it('returns the "Unlocks soon" stat and cue when there are habits but none unlocked yet', () => {
    const result = describeHabits(false, 2, 0, 0);
    expect(result.stat).toBe('Unlocks soon');
    expect(result.cue).toBe('Open habits →');
    expect(result.accessibilityLabel).toBe("Today's habits, unlocks soon. Open habits");
  });
});
