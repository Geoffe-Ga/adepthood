// Unlocking every habit at once is destructive enough (it bypasses every
// individual long-press confirm) that it needs its own confirmation dialog
// before the toggle action fires — distinct from the per-habit unlock
// confirm on a locked tile.
//
// Mirrors the isolated-component convention in HabitsScreenA11y.test.tsx:
// render HabitsDrawer directly with explicit props rather than mounting the
// whole screen + API layer.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'token' })),
}));
jest.mock('../components/AddHabitModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/GoalModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/HabitSettingsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/MissedDaysModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/OnboardingModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/ReorderHabitsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/StatsModal', () => ({ __esModule: true, default: () => null }));

import HabitsDrawer from '../components/HabitsDrawer';

const noop = (..._args: unknown[]): void => {};

const baseProps = {
  scale: 1,
  onSelectMode: noop,
  onOpenOnboarding: noop,
  onOpenAddHabit: noop,
  page: 0,
  pageCount: 1,
  onPrev: noop,
  onNext: noop,
  stageStart: 1,
  stageEnd: 10,
  barVisible: true,
  onToggleBarVisible: noop,
  onClose: noop,
};

afterEach(() => {
  jest.clearAllMocks();
});

describe('HabitsDrawer unlock-all confirm flow', () => {
  it('labels the toggle "Unlock All Habits" (not "Reveal All Habits") when nothing is unlocked', () => {
    const { getByRole } = render(
      <HabitsDrawer {...baseProps} allRevealed={false} onToggleReveal={jest.fn()} />,
    );
    expect(getByRole('button', { name: 'Unlock All Habits' })).toBeTruthy();
  });

  it('pressing "Unlock All Habits" opens a confirm dialog instead of firing the toggle immediately', () => {
    const onToggleReveal = jest.fn();
    const { getByRole, getByTestId } = render(
      <HabitsDrawer {...baseProps} allRevealed={false} onToggleReveal={onToggleReveal} />,
    );

    fireEvent.press(getByRole('button', { name: 'Unlock All Habits' }));

    expect(getByTestId('unlock-all-confirm')).toBeTruthy();
    expect(getByTestId('unlock-all-confirm-button')).toBeTruthy();
    expect(onToggleReveal).not.toHaveBeenCalled();
  });

  it('confirming the dialog invokes the unlock-all action exactly once', () => {
    const onToggleReveal = jest.fn();
    const { getByRole, getByTestId } = render(
      <HabitsDrawer {...baseProps} allRevealed={false} onToggleReveal={onToggleReveal} />,
    );

    fireEvent.press(getByRole('button', { name: 'Unlock All Habits' }));
    fireEvent.press(getByTestId('unlock-all-confirm-button'));

    expect(onToggleReveal).toHaveBeenCalledTimes(1);
  });

  it('cancelling does NOT invoke the unlock-all action', () => {
    const onToggleReveal = jest.fn();
    const { getByRole, getByTestId, queryByTestId } = render(
      <HabitsDrawer {...baseProps} allRevealed={false} onToggleReveal={onToggleReveal} />,
    );

    fireEvent.press(getByRole('button', { name: 'Unlock All Habits' }));
    fireEvent.press(getByTestId('unlock-all-cancel'));

    expect(onToggleReveal).not.toHaveBeenCalled();
    expect(queryByTestId('unlock-all-confirm')).toBeNull();
  });
});
