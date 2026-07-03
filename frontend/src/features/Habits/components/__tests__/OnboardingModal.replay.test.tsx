import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import type { ReactNode } from 'react';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../constants', () => ({
  ...(jest.requireActual('../../constants') as Record<string, unknown>),
  DEFAULT_ICONS: ['⭐'],
}));
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
// Only the header/footer slots matter here (no test in this file interacts
// with an individual reorder row), so the mock skips ``renderItem`` and the
// drag wiring entirely rather than reproducing the full fixture used by the
// reorder-focused suites.
jest.mock('react-native-draggable-flatlist', () => {
  const { View } = require('react-native');
  return function MockDraggableFlatList({
    testID,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    testID?: string;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) {
    return (
      <View testID={testID}>
        {ListHeaderComponent}
        {ListFooterComponent}
      </View>
    );
  };
});
jest.mock('../../../../api', () => ({
  goalGroups: {
    list: jest.fn(() => Promise.resolve([])),
  },
}));

const STAGGER_DELAY_MS = 150;
const SORT_PAUSE_MS = 500;
const REVEAL_SETTLE_MS = 100;
const REVEAL_TOTAL_MS = STAGGER_DELAY_MS * 1 + SORT_PAUSE_MS + REVEAL_SETTLE_MS;

const runOnePass = (result: ReturnType<typeof render>, habitName: string) => {
  const input = result.getByPlaceholderText('Enter habit name');
  fireEvent.changeText(input, habitName);
  fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });

  fireEvent.press(result.getByTestId('continue-button'));
  const warn = result.queryByTestId('count-warning-continue');
  if (warn) fireEvent.press(warn);
  fireEvent.press(result.getByTestId('continue-button'));

  act(() => {
    fireEvent.press(result.getByTestId('continue-button'));
  });
};

describe('OnboardingModal reveal replay guard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('skips the reveal animation on a second pass through onboarding in the same session', async () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);

    // First pass: the reveal animation plays out and finishes.
    runOnePass(result, 'Habit A');
    act(() => {
      jest.advanceTimersByTime(REVEAL_TOTAL_MS);
    });
    expect(result.getByText('Your optimal habit order:')).toBeTruthy();

    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(10);
    });
    fireEvent.press(result.getByTestId('finish-setup'));

    // Finishing resets to step 1 with an empty habit list, but the modal
    // instance stays mounted -- add a fresh habit and run the flow again.
    expect(result.getByText('Create Your Habits')).toBeTruthy();
    runOnePass(result, 'Habit B');

    // The second pass must land directly on the reorder step: the
    // multi-second stagger/sort reveal animation must not replay.
    expect(result.queryByText('Calculating your energy order...')).toBeNull();
    expect(result.getByTestId('reorder-list')).toBeTruthy();
  });
});
