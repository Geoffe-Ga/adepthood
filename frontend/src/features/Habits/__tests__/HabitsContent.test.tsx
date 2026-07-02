/* eslint-env jest */
// The loading / error+retry / empty / list branches of HabitsContent are
// otherwise only exercised indirectly through the full HabitsScreen, whose
// data-loading hook makes it awkward to pin each rendering branch directly.
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { View } from 'react-native';

import type { Habit } from '../Habits.types';
import { HabitsContent } from '../HabitsScreen';

// Stub the modal components — importing HabitsScreen pulls them in, and some
// carry native deps (e.g. datetimepicker) that don't load under jest.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'token' })),
}));
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('../components/AddHabitModal', () => () => null);
jest.mock('../components/GoalModal', () => () => null);
jest.mock('../components/HabitSettingsModal', () => () => null);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/StatsModal', () => () => null);

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

describe('HabitsContent', () => {
  it('shows the loading spinner and hides the list while loading', () => {
    const { getByTestId, queryByTestId } = render(
      <HabitsContent
        habits={[]}
        loading
        error={null}
        columns={1}
        gridGutter={8}
        renderItem={renderRow}
        onRetry={jest.fn()}
        onAddHabit={jest.fn()}
        pagination={null}
      />,
    );
    expect(getByTestId('loading-spinner')).toBeTruthy();
    expect(queryByTestId('habits-list')).toBeNull();
  });

  it('shows the error banner and fires onRetry when pressed', () => {
    const onRetry = jest.fn();
    const { getByTestId, getByText } = render(
      <HabitsContent
        habits={[]}
        loading={false}
        error="Could not load habits"
        columns={1}
        gridGutter={8}
        renderItem={renderRow}
        onRetry={onRetry}
        onAddHabit={jest.fn()}
        pagination={null}
      />,
    );
    expect(getByText('Could not load habits')).toBeTruthy();
    fireEvent.press(getByTestId('retry-button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('co-renders the list under the error banner instead of hiding it', () => {
    const habits = [makeHabit(1)];
    const { getByTestId } = render(
      <HabitsContent
        habits={habits}
        loading={false}
        error="Could not refresh"
        columns={1}
        gridGutter={8}
        renderItem={renderRow}
        onRetry={jest.fn()}
        onAddHabit={jest.fn()}
        pagination={null}
      />,
    );
    expect(getByTestId('habits-list')).toBeTruthy();
  });

  it('shows the empty state and fires onAddHabit when there are no habits', () => {
    const onAddHabit = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <HabitsContent
        habits={[]}
        loading={false}
        error={null}
        columns={1}
        gridGutter={8}
        renderItem={renderRow}
        onRetry={jest.fn()}
        onAddHabit={onAddHabit}
        pagination={null}
      />,
    );
    expect(queryByTestId('habits-list')).toBeNull();
    fireEvent.press(getByTestId('habits-empty-add'));
    expect(onAddHabit).toHaveBeenCalledTimes(1);
  });

  it('renders the pagination bar when pagination is supplied', () => {
    const habits = [makeHabit(1), makeHabit(2)];
    const { getByTestId } = render(
      <HabitsContent
        habits={habits}
        loading={false}
        error={null}
        columns={1}
        gridGutter={8}
        renderItem={renderRow}
        onRetry={jest.fn()}
        onAddHabit={jest.fn()}
        pagination={{ page: 0, pageCount: 3, onPrev: jest.fn(), onNext: jest.fn(), scale: 1 }}
      />,
    );
    expect(getByTestId('habits-pagination')).toBeTruthy();
  });

  it('omits the pagination bar when none is supplied', () => {
    const habits = [makeHabit(1)];
    const { queryByTestId } = render(
      <HabitsContent
        habits={habits}
        loading={false}
        error={null}
        columns={1}
        gridGutter={8}
        renderItem={renderRow}
        onRetry={jest.fn()}
        onAddHabit={jest.fn()}
        pagination={null}
      />,
    );
    expect(queryByTestId('habits-pagination')).toBeNull();
  });
});
