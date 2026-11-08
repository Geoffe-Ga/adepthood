/* eslint-env jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import DatePicker, { toISODate } from '../../../../components/DatePicker';
import { STAGE_COLORS } from '../../../../design/tokens';
import { useProgramStore } from '../../../../store/useProgramStore';
import { STAGE_ORDER } from '../../HabitUtils';

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
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    useProgramStore.setState({
      programStartDay: null,
      programStartDate: null,
      anchorSource: null,
      programStartWindow: null,
      programStartLocked: false,
    });
  });

  const REVEAL_TOTAL_MS = 150 * 2 + 500 + 100; // 2 habits × 150ms stagger + 500ms pause + 100ms settle

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
    // Advance through the reveal animation
    act(() => {
      jest.advanceTimersByTime(REVEAL_TOTAL_MS);
    });
    return result;
  };

  const getBorderColor = (elem: any) => {
    const styles = Array.isArray(elem.props.style) ? elem.props.style : [elem.props.style];
    const found = styles.find((s: any) => s && s.borderLeftColor);
    return found?.borderLeftColor as string | undefined;
  };

  it('names the start-date picker for the stage it actually begins', () => {
    // The picked date is habit index 0's start date verbatim, and index 0 is
    // Beige -- so the label names the stage rather than a list position the
    // user cannot see, and the date they choose is the one the whole program
    // calendar is anchored to.
    const { getByText, queryByText } = setupToReorder();

    expect(getByText('Beige begins on:')).toBeTruthy();
    expect(queryByText('First habit starts on:')).toBeNull();
  });

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

  describe('the start date is clamped to what the server accepts (#3097)', () => {
    const datePickerProps = (result: ReturnType<typeof setupToReorder>) =>
      result.UNSAFE_getByType(DatePicker).props as {
        value: string;
        minDate?: string;
        maxDate?: string;
      };

    it('offers nothing after today and reaches back before it', () => {
      const today = toISODate(new Date());

      const picker = datePickerProps(setupToReorder());

      expect(picker.maxDate).toBe(today);
      expect(picker.minDate).toBeDefined();
      expect(picker.minDate! < today).toBe(true);
    });

    it('takes the floor from the server window when one is held', () => {
      useProgramStore.setState({
        programStartWindow: { earliest: '2025-12-01', latest: '2026-01-01' },
      });

      expect(datePickerProps(setupToReorder()).minDate).toBe('2025-12-01');
    });

    it('pulls a legacy future anchor back to today rather than offering a refused date', () => {
      const future = new Date();
      future.setDate(future.getDate() + 30);
      useProgramStore.getState().setProgramStartDate(future);

      expect(datePickerProps(setupToReorder()).value).toBe(toISODate(new Date()));
    });

    it('shows a fixed date, not a picker, once begin-again has run', () => {
      useProgramStore.setState({ programStartLocked: true });

      const result = setupToReorder();

      expect(result.UNSAFE_queryByType(DatePicker)).toBeNull();
      expect(result.getByTestId('program-start-fixed')).toBeTruthy();
      expect(result.getByText(/begin again/i)).toBeTruthy();
    });
  });
});
