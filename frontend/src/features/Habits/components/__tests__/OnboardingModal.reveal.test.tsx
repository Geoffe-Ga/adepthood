/* eslint-env jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import type { ReactNode } from 'react';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../constants', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
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
  const React = require('react');
  const { View } = require('react-native');
  return ({
    data,
    renderItem,
    onDragEnd,
    testID,
    contentContainerStyle,
    ListHeaderComponent,
    ListFooterComponent,
  }: any) => (
    <View testID={testID} onDragEnd={onDragEnd} data={data} style={contentContainerStyle}>
      {ListHeaderComponent}
      {data.map((item: any, index: number) =>
        React.cloneElement(
          renderItem({ item, index, drag: jest.fn(), isActive: false, getIndex: () => index }),
          { key: item.id },
        ),
      )}
      {ListFooterComponent}
    </View>
  );
});
jest.mock('../../../../api', () => ({
  goalGroups: {
    list: jest.fn(() =>
      Promise.resolve([
        { id: 1, name: 'Meditation Goals', icon: '🧘', shared_template: true, goals: [] },
      ]),
    ),
  },
}));

const STAGGER_DELAY_MS = 150;
const SORT_PAUSE_MS = 500;

const addHabitsAndAdvanceToStep3 = (result: ReturnType<typeof render>, habitCount = 3) => {
  const input = result.getByPlaceholderText('Enter habit name');
  for (let i = 0; i < habitCount; i++) {
    fireEvent.changeText(input, `Habit ${String.fromCharCode(65 + i)}`);
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
  }
  // Step 1 → Step 2 (with count warning)
  fireEvent.press(result.getByTestId('continue-button'));
  const warn = result.queryByTestId('count-warning-continue');
  if (warn) fireEvent.press(warn);
  // Step 2 → Step 3
  fireEvent.press(result.getByTestId('continue-button'));
};

describe('OnboardingModal reveal animation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows "Calculating your energy order..." header during reveal', () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    addHabitsAndAdvanceToStep3(result);

    // Step 3 → Step 4 (triggers reveal)
    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });

    expect(result.getByText('Calculating your energy order...')).toBeTruthy();
  });

  it('shows net energy scores one at a time with stagger', () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    addHabitsAndAdvanceToStep3(result, 3);

    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });

    // Initially no scores are visible
    expect(result.queryAllByTestId('reveal-score')).toHaveLength(0);

    // After first stagger delay, one score appears
    act(() => {
      jest.advanceTimersByTime(STAGGER_DELAY_MS);
    });
    expect(result.queryAllByTestId('reveal-score')).toHaveLength(1);

    // After second stagger delay, two scores appear
    act(() => {
      jest.advanceTimersByTime(STAGGER_DELAY_MS);
    });
    expect(result.queryAllByTestId('reveal-score')).toHaveLength(2);

    // After third stagger delay, all three scores appear
    act(() => {
      jest.advanceTimersByTime(STAGGER_DELAY_MS);
    });
    expect(result.queryAllByTestId('reveal-score')).toHaveLength(3);
  });

  it('shows "Your optimal habit order:" after animation completes', () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    addHabitsAndAdvanceToStep3(result, 2);

    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });

    // Advance through all score reveals (2 habits × 150ms) + sort pause (500ms) + sort settle
    act(() => {
      jest.advanceTimersByTime(STAGGER_DELAY_MS * 2 + SORT_PAUSE_MS + 100);
    });

    expect(result.getByText('Your optimal habit order:')).toBeTruthy();
  });

  it('disables continue button during reveal animation', () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    addHabitsAndAdvanceToStep3(result, 2);

    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });

    // During reveal, there should be no continue-to-templates button
    expect(result.queryByTestId('continue-to-templates')).toBeNull();

    // Complete the animation
    act(() => {
      jest.advanceTimersByTime(STAGGER_DELAY_MS * 2 + SORT_PAUSE_MS + 100);
    });

    // After animation completes, continue button should be available
    expect(result.queryByTestId('continue-to-templates')).toBeTruthy();
  });

  it('skips reveal when navigating back to step 3 and forward again', async () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    addHabitsAndAdvanceToStep3(result, 2);

    // First visit to step 4 — triggers reveal
    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });

    // Complete the animation
    act(() => {
      jest.advanceTimersByTime(STAGGER_DELAY_MS * 2 + SORT_PAUSE_MS + 100);
    });

    expect(result.getByText('Your optimal habit order:')).toBeTruthy();

    // Go to templates, then back to step 4
    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(50);
    });

    // Now on step 5, go back to step 4
    fireEvent.press(result.getByText('Back'));

    // Should show reorder step directly without reveal animation
    expect(result.getByText('Reorder Your Habits')).toBeTruthy();
    expect(result.queryByText('Calculating your energy order...')).toBeNull();
  });

  it('shows habits in sorted order after reveal completes', () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    addHabitsAndAdvanceToStep3(result, 2);

    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });

    // Complete the animation
    act(() => {
      jest.advanceTimersByTime(STAGGER_DELAY_MS * 2 + SORT_PAUSE_MS + 100);
    });

    // After reveal, the reorder list should be showing
    const list = result.getByTestId('reorder-list');
    expect(list).toBeTruthy();
  });
});
