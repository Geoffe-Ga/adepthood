// audit-ux-01: the Habits screen chrome (header drawer, mode bar, pagination,
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
jest.mock('../components/AddHabitModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/GoalModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/HabitSettingsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/MissedDaysModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/OnboardingModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/ReorderHabitsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/StatsModal', () => ({ __esModule: true, default: () => null }));

import HabitsDrawer from '../components/HabitsDrawer';
import { EnergyCTA, ModeBar, PaginationBar } from '../HabitsScreen';

const noop = (..._args: unknown[]): void => {};

afterEach(() => {
  jest.clearAllMocks();
});

describe('HabitsScreen chrome accessibility', () => {
  describe('HabitsDrawer', () => {
    const baseProps = {
      scale: 1,
      onSelectMode: noop,
      onOpenOnboarding: noop,
      onOpenAddHabit: noop,
      allRevealed: false,
      onToggleReveal: noop,
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

    it('exposes each action row as a named button', () => {
      const { getByRole } = render(<HabitsDrawer {...baseProps} />);
      for (const name of ['Quick Log', 'Stats', 'Edit', 'Add Habit', 'Energy Scaffolding']) {
        expect(getByRole('button', { name })).toBeTruthy();
      }
      // The reveal toggle reflects the current allRevealed state in its label
      // (renamed from "Reveal All" to the plainer "Unlock All").
      expect(getByRole('button', { name: 'Unlock All Habits' })).toBeTruthy();
    });

    it('switches the reveal-toggle label when all habits are revealed', () => {
      const { getByRole } = render(<HabitsDrawer {...baseProps} allRevealed />);
      expect(getByRole('button', { name: 'Lock Unstarted Habits' })).toBeTruthy();
    });

    it('labels the pagination Prev/Next controls and disables Prev on the first page', () => {
      const { getByLabelText } = render(
        <HabitsDrawer {...baseProps} page={0} pageCount={3} stageStart={1} stageEnd={10} />,
      );
      expect(getByLabelText('Previous page').props.accessibilityState).toEqual({
        disabled: true,
      });
      expect(getByLabelText('Next page').props.accessibilityState).toEqual({ disabled: false });
    });
  });

  describe('ModeBar', () => {
    it('labels the exit button with the active mode', () => {
      const { getByLabelText } = render(<ModeBar mode="stats" onExit={noop} />);
      const exit = getByLabelText(/^Exit /);
      expect(exit.props.accessibilityRole).toBe('button');
      expect(exit.props.accessibilityLabel).toBe('Exit Stats Mode');
    });

    it('falls back to the raw mode when it is not in the label map', () => {
      const { getByLabelText } = render(<ModeBar mode="unknownmode" onExit={noop} />);
      expect(getByLabelText('Exit unknownmode')).toBeTruthy();
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

    it('shows the stage range as the visible label, moving the page position into the accessibility label', () => {
      const { getByText, getByTestId } = render(
        <PaginationBar
          page={0}
          pageCount={2}
          onPrev={noop}
          onNext={noop}
          scale={1}
          stageStart={1}
          stageEnd={10}
        />,
      );
      const rangeLabel = getByText(/Stages\s*1[\s\S]*10/);
      expect(rangeLabel).toBeTruthy();
      // The page position is announced on the visible range Text (an
      // accessibility element), not the container whose label a screen reader
      // would skip past its focusable children.
      expect(rangeLabel.props.accessibilityLabel).toMatch(/page 1 of 2/i);
      expect(getByTestId('habits-pagination')).toBeTruthy();
    });

    it('shows the second-lap stage range for page 2', () => {
      const { getByText } = render(
        <PaginationBar
          page={1}
          pageCount={2}
          onPrev={noop}
          onNext={noop}
          scale={1}
          stageStart={11}
          stageEnd={20}
        />,
      );
      expect(getByText(/Stages\s*11[\s\S]*20/)).toBeTruthy();
    });
  });

  describe('EnergyCTA', () => {
    it('labels the set-up and dismiss controls and they fire', () => {
      const onOpen = jest.fn();
      const onArchive = jest.fn();
      const { getByLabelText } = render(<EnergyCTA onOpen={onOpen} onArchive={onArchive} />);

      // Labels contain the visible button text (WCAG 2.5.3 Label-in-Name).
      fireEvent.press(getByLabelText('Perform Energy Scaffolding'));
      expect(onOpen).toHaveBeenCalledTimes(1);

      fireEvent.press(getByLabelText('Archive This energy scaffolding prompt'));
      expect(onArchive).toHaveBeenCalledTimes(1);
    });
  });
});
