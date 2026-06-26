import { describe, expect, it, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { BORDER_RADIUS, SPACING, colors as COLORS } from '../../../../design/tokens';

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

describe('OnboardingModal cost step', () => {
  const setupToCostStep = () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    const input = result.getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, 'Habit');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    fireEvent.press(result.getByTestId('continue-button'));
    fireEvent.press(result.getByTestId('count-warning-continue'));
    return result;
  };

  it('defaults cost sliders to 5', () => {
    const { getAllByTestId } = setupToCostStep();
    const sliders = getAllByTestId('cost-slider');
    sliders.forEach((slider) => {
      expect(slider.props.value).toBe(5);
    });
  });

  it('renders compact habit tiles', () => {
    const { getByTestId } = setupToCostStep();
    const tile = getByTestId('energy-tile-0');
    // "Compact" = the tight design-token spacing/shape, asserted by named value
    // (mirrors the value-asserting slider test below) rather than a snapshot blob.
    const style = StyleSheet.flatten(tile.props.style);
    expect(style.padding).toBe(SPACING.sm);
    expect(style.marginBottom).toBe(SPACING.sm);
    expect(style.borderRadius).toBe(BORDER_RADIUS.md);
    expect(style.backgroundColor).toBe(COLORS.background.primary);
  });

  it('applies mystical slider styling', () => {
    const { getAllByTestId } = setupToCostStep();
    const slider = getAllByTestId('cost-slider')[0];
    expect(slider.props.animateTransitions).toBe(true);
    expect(slider.props.minimumTrackTintColor).toBe(COLORS.secondary);
    expect(slider.props.thumbTintColor).toBe(COLORS.secondary);
  });
});
