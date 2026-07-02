import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

// EmojiSelector pulls in native bindings; render a stub.
jest.mock('react-native-emoji-selector', () => () => null);

jest.mock('../../../../api', () => ({
  __esModule: true,
  goalGroups: {
    get: jest.fn(),
  },
}));

jest.mock('../../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: 'UTC' }),
}));

import { goalGroups as goalGroupsApi } from '../../../../api';
import type { Goal, Habit } from '../../Habits.types';
import { GoalModal } from '../GoalModal';

const mockGet = goalGroupsApi.get as jest.MockedFunction<typeof goalGroupsApi.get>;

const makeGoal = (tier: 'low' | 'clear' | 'stretch', overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  title: `${tier} goal`,
  tier,
  target: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  target_unit: 'units',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 42,
  stage: 'Beige',
  name: 'Meditation',
  icon: '🧘',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [makeGoal('low'), makeGoal('clear'), makeGoal('stretch')],
  completions: [],
  revealed: true,
  ...overrides,
});

const renderModal = (habit: Habit) =>
  render(
    <GoalModal
      visible
      habit={habit}
      onClose={jest.fn()}
      onUpdateGoal={jest.fn()}
      onUpdateGoalUnits={jest.fn()}
      onLogUnit={jest.fn()}
      onUpdateHabit={jest.fn()}
    />,
  );

describe('GoalModal goal-group badge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not fetch a goal group when no goal references one', () => {
    renderModal(makeHabit());
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('shows the goal-group badge once the linked group resolves', async () => {
    mockGet.mockResolvedValueOnce({
      id: 5,
      name: 'Meditation Bundle',
      icon: '🧘',
      shared_template: true,
      goals: [],
    });
    const habit = makeHabit({
      goals: [makeGoal('low', { goal_group_id: 5 }), makeGoal('clear'), makeGoal('stretch')],
    });

    const { findByTestId, findByText } = renderModal(habit);

    expect(await findByTestId('goal-group-badge')).toBeTruthy();
    expect(await findByText(/Meditation Bundle/)).toBeTruthy();
    expect(mockGet).toHaveBeenCalledWith(5);
  });

  it('leaves the badge hidden when the linked group fetch fails', async () => {
    mockGet.mockRejectedValueOnce(new Error('network down'));
    const habit = makeHabit({
      goals: [makeGoal('low', { goal_group_id: 7 }), makeGoal('clear'), makeGoal('stretch')],
    });

    const { queryByTestId } = renderModal(habit);

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(7));
    expect(queryByTestId('goal-group-badge')).toBeNull();
  });
});
