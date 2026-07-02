import { describe, expect, it, jest } from '@jest/globals';
import { render, fireEvent, within } from '@testing-library/react-native';
import React from 'react';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../constants', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('@react-native-community/slider', () => 'Slider');
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
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

const setupToCostStep = () => {
  const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
  const input = result.getByPlaceholderText('Enter habit name');
  fireEvent.changeText(input, 'Habit');
  fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
  fireEvent.press(result.getByTestId('continue-button'));
  fireEvent.press(result.getByTestId('count-warning-continue'));
  return result;
};

const setupToReturnStep = () => {
  const result = setupToCostStep();
  fireEvent.press(result.getByTestId('continue-button'));
  return result;
};

describe('OnboardingModal cost slider bounds', () => {
  it('updates the tile value when the slider moves within range', () => {
    const { getByTestId } = setupToCostStep();
    fireEvent(getByTestId('cost-slider'), 'valueChange', 8);

    const tile = getByTestId('energy-tile-0');
    expect(within(tile).getByText('8')).toBeTruthy();
  });

  it('ignores a slider value below the valid 0-10 range', () => {
    const { getByTestId } = setupToCostStep();
    fireEvent(getByTestId('cost-slider'), 'valueChange', -1);

    const tile = getByTestId('energy-tile-0');
    expect(within(tile).getByText('5')).toBeTruthy();
  });

  it('ignores a slider value above the valid 0-10 range', () => {
    const { getByTestId } = setupToCostStep();
    fireEvent(getByTestId('cost-slider'), 'valueChange', 11);

    const tile = getByTestId('energy-tile-0');
    expect(within(tile).getByText('5')).toBeTruthy();
  });

  it('rounds a fractional slider value to the nearest whole number', () => {
    const { getByTestId } = setupToCostStep();
    fireEvent(getByTestId('cost-slider'), 'valueChange', 6.6);

    const tile = getByTestId('energy-tile-0');
    expect(within(tile).getByText('7')).toBeTruthy();
  });
});

describe('OnboardingModal return energy step', () => {
  it('shows the Energy Return title and subtitle copy', () => {
    const { getByText } = setupToReturnStep();
    getByText('Energy Return');
    getByText(/lights you up and feels deeply rewarding/i);
  });

  it('updates the return-energy tile value when its slider moves', () => {
    const { getByTestId } = setupToReturnStep();
    fireEvent(getByTestId('return-slider'), 'valueChange', 9);

    const tile = getByTestId('energy-tile-0');
    expect(within(tile).getByText('9')).toBeTruthy();
  });

  it('navigates back to the cost step via the Back button', () => {
    const { getByText, queryByText } = setupToReturnStep();
    fireEvent.press(getByText('Back'));

    getByText('Energy Cost');
    expect(queryByText('Energy Return')).toBeNull();
  });
});

describe('OnboardingModal cost step Back-and-forth navigation', () => {
  it('navigates back to step 1 via the cost step Back button', () => {
    const { getByText, queryByText } = setupToCostStep();
    fireEvent.press(getByText('Back'));

    getByText('Create Your Habits');
    expect(queryByText('Energy Cost')).toBeNull();
  });
});
