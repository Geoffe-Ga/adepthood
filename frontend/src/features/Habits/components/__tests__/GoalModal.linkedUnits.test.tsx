/**
 * #3154: a habit the journal's writing timer or a practice logs to is fed by
 * the timer, which can only measure minutes or whole sessions, scored per day
 * or per week. The units editor offers exactly those, says why, and leaves an
 * unlinked habit with every unit it has today.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

const mockPracticeList = jest.fn<() => Promise<{ id: number; habit_id?: number | null }[]>>();

jest.mock('../../../../api', () => ({
  __esModule: true,
  goalGroups: { get: jest.fn(() => Promise.resolve(null)) },
  userPractices: { list: () => mockPracticeList() },
  uiFlags: { get: jest.fn(() => Promise.resolve({ writing_session_habit_id: null })) },
}));

jest.mock('../../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: 'UTC' }),
}));

import { useWritingHabitLinkStore } from '../../../../store/useWritingHabitLinkStore';
import { FREQUENCY_UNITS, TARGET_UNITS } from '../../constants';
import type { Goal, Habit } from '../../Habits.types';
import { GoalModal, LINKED_HABIT_UNITS_NOTE } from '../GoalModal';

const HABIT_ID = 42;

const makeGoal = (tier: 'low' | 'clear' | 'stretch', overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  title: `${tier} goal`,
  tier,
  target: tier === 'low' ? 10 : tier === 'clear' ? 20 : 45,
  target_unit: 'minutes',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

const makeHabit = (goalOverrides: Partial<Goal> = {}): Habit => ({
  id: HABIT_ID,
  stage: 'Beige',
  name: 'Journaling',
  icon: '✍️',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [
    makeGoal('low', goalOverrides),
    makeGoal('clear', goalOverrides),
    makeGoal('stretch', goalOverrides),
  ],
  completions: [],
  revealed: true,
});

const renderEditor = (habit: Habit = makeHabit()) => {
  const onUpdateGoalUnits = jest.fn();
  const utils = render(
    <GoalModal
      visible
      habit={habit}
      onClose={jest.fn()}
      onUpdateGoal={jest.fn()}
      onUpdateGoalUnits={onUpdateGoalUnits}
      onLogUnit={jest.fn()}
      onUpdateHabit={jest.fn()}
    />,
  );
  fireEvent.press(utils.getByTestId('goal-modal-edit-toggle'));
  return { ...utils, onUpdateGoalUnits };
};

const chipValues = (row: ReturnType<typeof within>, testID: string, all: readonly string[]) =>
  all.filter((value) => row.queryByTestId(`${testID}-${value}`) !== null);

describe('GoalModal units editor for a timer-fed habit', () => {
  beforeEach(() => {
    mockPracticeList.mockReset();
    mockPracticeList.mockResolvedValue([]);
    useWritingHabitLinkStore.getState().reset();
  });

  it('offers every unit and cadence, and no timer note, to an unlinked habit', async () => {
    const { getByTestId, queryByText } = renderEditor();
    await waitFor(() => expect(mockPracticeList).toHaveBeenCalled());
    const units = within(getByTestId('goal-target-unit'));
    expect(chipValues(units, 'goal-target-unit', TARGET_UNITS)).toEqual([...TARGET_UNITS]);
    expect(TARGET_UNITS).toHaveLength(20);
    const cadence = within(getByTestId('goal-frequency-unit'));
    expect(chipValues(cadence, 'goal-frequency-unit', FREQUENCY_UNITS)).toEqual([
      ...FREQUENCY_UNITS,
    ]);
    expect(queryByText(LINKED_HABIT_UNITS_NOTE)).toBeNull();
    expect(getByTestId('goal-direction-row')).toBeTruthy();
  });

  it('offers only minutes/sessions and per day/per week to the journal-linked habit', () => {
    useWritingHabitLinkStore.setState({ habitId: HABIT_ID, hydrated: true });
    const { getByTestId, getByText, queryByTestId } = renderEditor();
    const units = within(getByTestId('goal-target-unit'));
    expect(chipValues(units, 'goal-target-unit', TARGET_UNITS)).toEqual(['minutes', 'sessions']);
    const cadence = within(getByTestId('goal-frequency-unit'));
    expect(chipValues(cadence, 'goal-frequency-unit', FREQUENCY_UNITS)).toEqual([
      'per_day',
      'per_week',
    ]);
    expect(getByText(LINKED_HABIT_UNITS_NOTE)).toBeTruthy();
    expect(LINKED_HABIT_UNITS_NOTE).toBe(
      'Logged automatically by the timer — minutes, or one session per sitting.',
    );
    // A timer only ever adds what it measured, so "Cut back" has no meaning here.
    expect(queryByTestId('goal-direction-row')).toBeNull();
  });

  it('treats a habit a practice logs to as timer-fed', async () => {
    mockPracticeList.mockResolvedValue([
      { id: 1, habit_id: 7 },
      { id: 2, habit_id: HABIT_ID },
    ]);
    const { findByText, getByTestId } = renderEditor();
    expect(await findByText(LINKED_HABIT_UNITS_NOTE)).toBeTruthy();
    const units = within(getByTestId('goal-target-unit'));
    expect(chipValues(units, 'goal-target-unit', TARGET_UNITS)).toEqual(['minutes', 'sessions']);
  });

  it('keeps a legacy unit and cadence visible beside the allowed chips so they can be fixed', () => {
    useWritingHabitLinkStore.setState({ habitId: HABIT_ID, hydrated: true });
    const { getByTestId, onUpdateGoalUnits } = renderEditor(
      makeHabit({ target_unit: 'reps', frequency_unit: 'per_month' }),
    );
    const units = within(getByTestId('goal-target-unit'));
    expect(chipValues(units, 'goal-target-unit', TARGET_UNITS)).toEqual([
      'minutes',
      'reps',
      'sessions',
    ]);
    const cadence = within(getByTestId('goal-frequency-unit'));
    expect(chipValues(cadence, 'goal-frequency-unit', FREQUENCY_UNITS)).toEqual([
      'per_day',
      'per_week',
      'per_month',
    ]);
    fireEvent.press(getByTestId('goal-target-unit-sessions'));
    expect(onUpdateGoalUnits).toHaveBeenCalledWith(HABIT_ID, { target_unit: 'sessions' });
  });

  it('commits a unit pick through the shared batch update', () => {
    useWritingHabitLinkStore.setState({ habitId: HABIT_ID, hydrated: true });
    const { getByTestId, onUpdateGoalUnits } = renderEditor();
    fireEvent.press(getByTestId('goal-frequency-unit-per_week'));
    expect(onUpdateGoalUnits).toHaveBeenCalledWith(HABIT_ID, { frequency_unit: 'per_week' });
  });
});
