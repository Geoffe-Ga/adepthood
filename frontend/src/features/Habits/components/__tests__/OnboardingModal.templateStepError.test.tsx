import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';

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
jest.mock('../../../../api', () => ({
  goalGroups: {
    list: jest.fn(() => Promise.reject(new Error('network down'))),
  },
}));

const STAGGER_DELAY_MS = 150;
const SORT_PAUSE_MS = 500;

const advanceToTemplatesGate = (result: ReturnType<typeof render>) => {
  const input = result.getByPlaceholderText('Enter habit name');
  fireEvent.changeText(input, 'Habit A');
  fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });

  fireEvent.press(result.getByTestId('continue-button'));
  const warn = result.queryByTestId('count-warning-continue');
  if (warn) fireEvent.press(warn);
  fireEvent.press(result.getByTestId('continue-button'));

  act(() => {
    fireEvent.press(result.getByTestId('continue-button'));
  });
  act(() => {
    jest.advanceTimersByTime(STAGGER_DELAY_MS + SORT_PAUSE_MS + 100);
  });
};

describe('OnboardingModal template step (fetch failure)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('saves the habits and closes immediately when the templates fetch fails', async () => {
    const onSave = jest.fn();
    const onClose = jest.fn();
    const result = render(<OnboardingModal visible onClose={onClose} onSaveHabits={onSave} />);
    advanceToTemplatesGate(result);

    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(10);
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.queryByTestId('finish-setup')).toBeNull();
  });
});
