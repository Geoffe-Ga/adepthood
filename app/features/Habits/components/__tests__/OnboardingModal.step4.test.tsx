/* eslint-env jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { STAGE_COLORS } from '../../../../constants/stageColors';
import { STAGE_ORDER } from '../../HabitUtils';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../HabitsScreen', () => ({ DEFAULT_ICONS: ['⭐'] }));
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

describe('OnboardingModal reorder step', () => {
  const setupToReorder = () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    const input = result.getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, 'Habit A');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    fireEvent.changeText(input, 'Habit B');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    const advance = () => {
      fireEvent.press(result.getByTestId('continue-button'));
      const warn = result.queryByTestId('count-warning-continue');
      if (warn) fireEvent.press(warn);
    };
    advance();
    advance();
    advance();
    return result;
  };

  const getBorderColor = (elem: any) => {
    const styles = Array.isArray(elem.props.style) ? elem.props.style : [elem.props.style];
    const found = styles.find((s: any) => s && s.borderLeftColor);
    return found?.borderLeftColor as string | undefined;
  };

  it('maps stage colors by index and updates after reorder', () => {
    const { getByTestId } = setupToReorder();
    const list = getByTestId('reorder-list');
    const data = list.props.data;
    const firstId = data[0].id;
    const secondId = data[1].id;

    expect(getBorderColor(getByTestId(`reorder-item-${firstId}`))).toBe(
      STAGE_COLORS[STAGE_ORDER[0] as keyof typeof STAGE_COLORS],
    );
    expect(getBorderColor(getByTestId(`reorder-item-${secondId}`))).toBe(
      STAGE_COLORS[STAGE_ORDER[1] as keyof typeof STAGE_COLORS],
    );

    const newOrder = [data[1], data[0]];
    const { act } = require('react-test-renderer');
    act(() => {
      list.props.onDragEnd({ data: newOrder });
    });

    expect(getBorderColor(getByTestId(`reorder-item-${secondId}`))).toBe(
      STAGE_COLORS[STAGE_ORDER[0] as keyof typeof STAGE_COLORS],
    );
    expect(getBorderColor(getByTestId(`reorder-item-${firstId}`))).toBe(
      STAGE_COLORS[STAGE_ORDER[1] as keyof typeof STAGE_COLORS],
    );
  });

  it('modal content constrains height', () => {
    const { getByTestId } = setupToReorder();
    const modal = getByTestId('onboarding-modal-content');
    const styles = Array.isArray(modal.props.style) ? modal.props.style : [modal.props.style];
    const found = styles.find((s: any) => s && s.height);
    expect(found?.height).toBe('90%');
  });
});
