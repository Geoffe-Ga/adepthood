// audit-ux-01: the Habits screen chrome (overflow menu, mode bar, pagination,
// energy CTA) must expose accessibilityRole/Label/State so screen-reader users
// can identify and operate the controls.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

// HabitsScreen pulls these in at import time; stub them so the module loads.
// The modal stubs use the explicit default-export form (the modals are default
// exports) to match the sibling chrome tests. Factories are inlined because
// jest hoists jest.mock above module scope, so they cannot reference outer vars.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'token' })),
}));
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('../components/AddHabitModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/GoalModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/HabitSettingsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/MissedDaysModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/OnboardingModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/ReorderHabitsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/StatsModal', () => ({ __esModule: true, default: () => null }));

import { EnergyCTA, ModeBar, OverflowMenu, PaginationBar } from '../HabitsScreen';

const noop = (): void => {};

afterEach(() => {
  jest.clearAllMocks();
});

describe('HabitsScreen chrome accessibility', () => {
  describe('OverflowMenu', () => {
    const baseProps = {
      scale: 1,
      onToggle: noop,
      onSelectMode: noop,
      onOpenOnboarding: noop,
      onOpenAddHabit: noop,
      allRevealed: false,
      onToggleReveal: noop,
    };

    it('labels the toggle and reflects its expanded state', () => {
      const { getByLabelText, rerender } = render(
        <OverflowMenu {...baseProps} menuVisible={false} />,
      );
      const toggle = getByLabelText('Habit options menu');
      expect(toggle.props.accessibilityState).toEqual({ expanded: false });

      rerender(<OverflowMenu {...baseProps} menuVisible />);
      expect(getByLabelText('Habit options menu').props.accessibilityState).toEqual({
        expanded: true,
      });
    });

    it('exposes each open menu item as a named button', () => {
      const { getByRole } = render(<OverflowMenu {...baseProps} menuVisible />);
      for (const name of ['Quick Log', 'Stats', 'Edit', 'Add Habit', 'Energy Scaffolding']) {
        expect(getByRole('button', { name })).toBeTruthy();
      }
      // The reveal toggle reflects the current allRevealed state in its label.
      expect(getByRole('button', { name: 'Reveal All Habits' })).toBeTruthy();
    });

    it('switches the reveal-toggle label when all habits are revealed', () => {
      const { getByRole } = render(<OverflowMenu {...baseProps} menuVisible allRevealed />);
      expect(getByRole('button', { name: 'Lock Unstarted Habits' })).toBeTruthy();
    });
  });

  describe('ModeBar', () => {
    it('labels the exit button with the active mode', () => {
      const { getByLabelText } = render(<ModeBar mode="stats" onExit={noop} />);
      const exit = getByLabelText(/^Exit /);
      expect(exit.props.accessibilityRole).toBe('button');
      expect(exit.props.accessibilityLabel).toBe('Exit Stats Mode');
    });
  });

  describe('PaginationBar', () => {
    it('labels prev/next and disables prev on the first page', () => {
      const { getByLabelText } = render(
        <PaginationBar page={0} pageCount={3} onPrev={noop} onNext={noop} scale={1} />,
      );
      expect(getByLabelText('Previous page').props.accessibilityState).toEqual({ disabled: true });
      expect(getByLabelText('Next page').props.accessibilityState).toEqual({ disabled: false });
    });

    it('enables prev and disables next on the last page', () => {
      const { getByLabelText } = render(
        <PaginationBar page={2} pageCount={3} onPrev={noop} onNext={noop} scale={1} />,
      );
      expect(getByLabelText('Previous page').props.accessibilityState).toEqual({ disabled: false });
      expect(getByLabelText('Next page').props.accessibilityState).toEqual({ disabled: true });
    });

    it('enables both controls on a middle page', () => {
      const { getByLabelText } = render(
        <PaginationBar page={1} pageCount={3} onPrev={noop} onNext={noop} scale={1} />,
      );
      expect(getByLabelText('Previous page').props.accessibilityState).toEqual({ disabled: false });
      expect(getByLabelText('Next page').props.accessibilityState).toEqual({ disabled: false });
    });
  });

  describe('EnergyCTA', () => {
    it('labels the set-up and dismiss controls and they fire', () => {
      const onOpen = jest.fn();
      const onArchive = jest.fn();
      const { getByLabelText } = render(<EnergyCTA onOpen={onOpen} onArchive={onArchive} />);

      fireEvent.press(getByLabelText('Set up energy scaffolding'));
      expect(onOpen).toHaveBeenCalledTimes(1);

      fireEvent.press(getByLabelText('Dismiss energy scaffolding prompt'));
      expect(onArchive).toHaveBeenCalledTimes(1);
    });
  });
});
