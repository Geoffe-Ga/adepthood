import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../constants', () => ({
  ...(jest.requireActual('../../constants') as Record<string, unknown>),
  DEFAULT_ICONS: ['⭐'],
}));
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
  }: {
    data: { id: string }[];
    renderItem: (info: {
      item: { id: string };
      index: number;
      drag: () => void;
      isActive: boolean;
      getIndex: () => number;
    }) => ReactElement;
    onDragEnd?: (info: unknown) => void;
    testID?: string;
    contentContainerStyle?: unknown;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <View testID={testID} onDragEnd={onDragEnd} data={data} style={contentContainerStyle}>
      {ListHeaderComponent}
      {data.map((item, index) =>
        React.cloneElement(
          renderItem({ item, index, drag: jest.fn(), isActive: false, getIndex: () => index }),
          { key: item.id },
        ),
      )}
      {ListFooterComponent}
    </View>
  );
});

const REVEAL_TOTAL_MS = 150 * 2 + 500 + 100; // 2 habits x 150ms stagger + 500ms pause + 100ms settle

const setupToReorder = () => {
  const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
  const input = result.getByPlaceholderText('Enter habit name');
  fireEvent.changeText(input, 'Habit A');
  fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
  jest.advanceTimersByTime(1); // ensure unique Date.now() IDs
  fireEvent.changeText(input, 'Habit B');
  fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
  const advance = () => {
    fireEvent.press(result.getByTestId('continue-button'));
    const warn = result.queryByTestId('count-warning-continue');
    if (warn) fireEvent.press(warn);
  };
  advance();
  advance();
  act(() => {
    advance();
  });
  act(() => {
    jest.advanceTimersByTime(REVEAL_TOTAL_MS);
  });
  return result;
};

describe('OnboardingModal reorder step icon editing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens the emoji picker for a habit and applies the selected icon', () => {
    const { getAllByText, getByText, UNSAFE_root } = setupToReorder();
    fireEvent.press(getAllByText('📝')[0]!);

    const selector = UNSAFE_root.findByType('EmojiSelector');
    fireEvent(selector, 'onEmojiSelected', '🎯');

    getByText('🎯 Habit A');
    expect(() => UNSAFE_root.findByType('EmojiSelector')).toThrow();
  });

  it('closes the emoji picker without changing the icon when dismissed via the close button', () => {
    const { getAllByText, getByText, queryByText, UNSAFE_root } = setupToReorder();
    fireEvent.press(getAllByText('📝')[0]!);
    expect(UNSAFE_root.findByType('EmojiSelector')).toBeTruthy();

    const closeButtons = getAllByText('×');
    fireEvent.press(closeButtons[closeButtons.length - 1]!);

    expect(() => UNSAFE_root.findByType('EmojiSelector')).toThrow();
    expect(queryByText('🎯 Habit A')).toBeNull();
    getByText('⭐ Habit A');
  });
});
