/* eslint-env jest */
// audit-ux-07: a zero-habit (first-run) user must see guidance, not a blank screen.
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { HabitsEmptyState } from '../components/HabitsEmptyState';
import type { Habit } from '../Habits.types';
import { HabitsContent } from '../HabitsScreen';

// HabitsContent lives in HabitsScreen.tsx, whose module graph pulls in the
// add-habit modal stack + notifications; mock those (same preamble the
// flatlist-config suite uses) so importing the screen's exports is cheap.
// jest hoists these above the imports above, so the mocks apply on load.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
}));
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('../components/AddHabitModal', () => () => null);
jest.mock('../components/GoalModal', () => () => null);
jest.mock('../components/HabitSettingsModal', () => () => null);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/StatsModal', () => () => null);

describe('HabitsEmptyState', () => {
  it('renders the guidance title and subtitle', () => {
    const { getByText, getByTestId } = render(<HabitsEmptyState />);
    expect(getByTestId('habits-empty-state')).toBeTruthy();
    expect(getByText('No habits yet')).toBeTruthy();
    expect(getByText(/start building momentum/i)).toBeTruthy();
  });

  it('omits the CTA when no onAdd is provided', () => {
    const { queryByTestId } = render(<HabitsEmptyState />);
    expect(queryByTestId('habits-empty-add')).toBeNull();
  });

  it('renders a screen-reader-labeled CTA that fires onAdd', () => {
    const onAdd = jest.fn();
    const { getByTestId, getByLabelText } = render(<HabitsEmptyState onAdd={onAdd} />);
    expect(getByLabelText('Add a habit')).toBeTruthy();
    fireEvent.press(getByTestId('habits-empty-add'));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

const sampleHabit = { id: 1, name: 'Meditate' } as unknown as Habit;
const renderTile = () => (<></>) as unknown as React.ReactElement;
const baseProps = {
  columns: 2,
  gridGutter: 8,
  renderItem: renderTile,
  onRetry: jest.fn(),
  onAddHabit: jest.fn(),
  pagination: null,
};

describe('HabitsContent empty branch (audit-ux-07)', () => {
  it('shows the empty state (not the list) for a zero-habit, loaded, error-free screen', () => {
    const { getByTestId, queryByTestId } = render(
      <HabitsContent {...baseProps} habits={[]} loading={false} error={null} />,
    );
    expect(getByTestId('habits-empty-state')).toBeTruthy();
    expect(queryByTestId('habits-list')).toBeNull();
  });

  it('shows the list (not the empty state) when habits are present', () => {
    const { getByTestId, queryByTestId } = render(
      <HabitsContent {...baseProps} habits={[sampleHabit]} loading={false} error={null} />,
    );
    expect(getByTestId('habits-list')).toBeTruthy();
    expect(queryByTestId('habits-empty-state')).toBeNull();
  });

  it('suppresses the empty state while loading (spinner wins)', () => {
    const { getByTestId, queryByTestId } = render(
      <HabitsContent {...baseProps} habits={[]} loading error={null} />,
    );
    expect(getByTestId('loading-spinner')).toBeTruthy();
    expect(queryByTestId('habits-empty-state')).toBeNull();
  });

  it('suppresses the empty state when an error banner is shown', () => {
    const { getByTestId, queryByTestId } = render(
      <HabitsContent {...baseProps} habits={[]} loading={false} error="Network down" />,
    );
    expect(getByTestId('retry-button')).toBeTruthy();
    expect(queryByTestId('habits-empty-state')).toBeNull();
  });
});
