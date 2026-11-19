/**
 * A refused new pass reaches the person on every platform (#3728).
 *
 * Drives the real modal into the real ``habitManager.onboardingSave`` with only
 * the network stubbed: the server refuses ``POST /stages/passes`` with 422
 * ``pass_start_before_current_pass``, and the modal's own dialog -- not a
 * native ``Alert``, which react-native-web drops -- shows the copy.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import type { ReactElement, ReactNode } from 'react';

import type * as ApiModule from '../../../../api';
import { useHabitStore } from '../../../../store/useHabitStore';
import { useProgramStore } from '../../../../store/useProgramStore';
import type { Habit } from '../../Habits.types';
import { habitManager } from '../../services/habitManager';

jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: ReactNode }) => children,
  Gesture: {
    LongPress: () => ({ minDuration: () => ({ onStart: () => ({}) }) }),
    Pan: () => ({ onBegin: () => ({}) }),
    Race: () => ({}),
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  View: require('react-native').View,
}));
jest.mock('react-native-draggable-flatlist', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: { id: string }[];
    renderItem: (_info: {
      item: { id: string };
      index: number;
      drag: () => void;
      isActive: boolean;
      getIndex: () => number;
    }) => ReactElement;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <View>
      {ListHeaderComponent}
      {data.map((item, index) =>
        ReactLib.cloneElement(
          renderItem({ item, index, drag: jest.fn(), isActive: false, getIndex: () => index }),
          { key: item.id },
        ),
      )}
      {ListFooterComponent}
    </View>
  );
});

const mockOpenPass = jest.fn<(_day: string) => Promise<never>>();
jest.mock('../../../../api', () => {
  const actual = jest.requireActual<typeof ApiModule>('../../../../api');
  return {
    ...actual,
    goalGroups: { list: jest.fn(() => Promise.resolve([])) },
    habits: {
      listAll: jest.fn(() => Promise.resolve([])),
      create: jest.fn(() => Promise.resolve({})),
      update: jest.fn(() => Promise.resolve({})),
      delete: jest.fn(() => Promise.resolve({})),
    },
    stages: {
      openPass: (day: string) => mockOpenPass(day),
      setProgramStart: jest.fn(() => Promise.reject(new Error('not expected'))),
      listAll: jest.fn(() => Promise.resolve([])),
    },
  };
});

const OnboardingModal = require('../OnboardingModal').default;

const REVEAL_TOTAL_MS = 150 * 4 + 500 + 100;
const TEMPLATES_SETTLE_MS = 10;
const ZONE = 'UTC';

const held: Habit = {
  id: 7,
  name: 'Meditate',
  icon: '🧘',
  stage: 'Beige',
  streak: 4,
  revealed: true,
  energy_cost: 3,
  energy_return: 8,
  start_date: new Date('2026-01-01'),
  goals: [],
  completions: [],
} as Habit;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const { ApiError } = jest.requireActual<typeof ApiModule>('../../../../api');
  mockOpenPass.mockReset().mockRejectedValue(new ApiError(422, 'pass_start_before_current_pass'));
  useHabitStore.setState({ habits: [held], loading: false, error: null });
  useProgramStore.setState({
    programStartDay: '2026-01-01',
    passStartWindow: { earliest: '2026-01-02', latest: '2099-12-31' },
  });
});

afterEach(() => {
  jest.useRealTimers();
  act(() => {
    useProgramStore.getState().reset();
    useHabitStore.setState({ habits: [] });
  });
});

describe('a refused new pass (#3728)', () => {
  it('shows the 422 pass_start_before_current_pass copy in the start-day dialog', async () => {
    const result = render(
      <OnboardingModal
        visible
        onClose={jest.fn()}
        existingHabits={[held]}
        userTimezone={ZONE}
        onSaveHabits={(picks: never, day: string, options: never) =>
          void habitManager.onboardingSave(picks, undefined, ZONE, day, options)
        }
      />,
    );

    fireEvent.press(result.getByTestId('review-continue'));
    fireEvent.press(result.getByTestId('continue-button'));
    const warn = result.queryByTestId('count-warning-continue');
    if (warn) fireEvent.press(warn);
    fireEvent.press(result.getByTestId('continue-button'));
    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });
    act(() => {
      jest.advanceTimersByTime(REVEAL_TOTAL_MS);
    });
    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(TEMPLATES_SETTLE_MS);
    });
    fireEvent.press(result.getByTestId('finish-setup'));

    await waitFor(() => expect(result.getByTestId('start-day-notice')).toBeTruthy());
    expect(mockOpenPass).toHaveBeenCalledTimes(1);
    expect(
      result.getByText(
        "A new pass can't start before the pass you're in began. Pick that day or a later one; your current pass keeps running.",
      ),
    ).toBeTruthy();
  });
});
