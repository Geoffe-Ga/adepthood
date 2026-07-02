import { describe, expect, it, jest } from '@jest/globals';
import { render, fireEvent, within } from '@testing-library/react-native';
import React from 'react';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../constants', () => ({
  ...(jest.requireActual('../../constants') as Record<string, unknown>),
  DEFAULT_ICONS: ['⭐'],
}));
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
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

describe('OnboardingModal step 1 extra interactions', () => {
  it('ignores key presses other than Enter', () => {
    const { getByPlaceholderText, getByTestId } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, 'Stretch');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'a' } });

    expect(getByTestId('habit-count')).toHaveTextContent('0 / 10');
    expect(input.props.value).toBe('Stretch');
  });

  it('pressing Enter with a blank input does not add a habit', () => {
    const { getByPlaceholderText, getByTestId } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, '   ');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });

    expect(getByTestId('habit-count')).toHaveTextContent('0 / 10');
  });

  it('Cmd+Enter does nothing when there are no habits yet', () => {
    const { getByPlaceholderText, getByText, queryByText } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter', metaKey: true } });

    expect(queryByText('Energy Cost')).toBeNull();
    getByText('Create Your Habits');
  });

  it('removes a habit from the list when its chip X is pressed', () => {
    const { getByPlaceholderText, getByTestId, queryByTestId } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, 'Yoga');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    expect(getByTestId('habit-count')).toHaveTextContent('1 / 10');

    const chip = getByTestId('habit-chip');
    fireEvent.press(within(chip).getByText('×'));

    expect(queryByTestId('habit-chip')).toBeNull();
    expect(getByTestId('habit-count')).toHaveTextContent('0 / 10');
  });

  it('Keep Adding on the count-warning dialog stays on step 1', () => {
    const { getByPlaceholderText, getByTestId, getByText, queryByText } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, 'Read');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    fireEvent.press(getByTestId('continue-button'));
    getByText("You've entered 1 of 10. Continue anyway?");

    fireEvent.press(getByTestId('count-warning-keep'));

    expect(queryByText('Energy Cost')).toBeNull();
    getByText('Create Your Habits');
  });

  it('Continue with exactly 10 habits skips the count-warning dialog', () => {
    const { getByPlaceholderText, getByTestId, getByText, queryByText } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    for (let i = 0; i < 10; i++) {
      fireEvent.changeText(input, `Habit ${i}`);
      fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    }
    expect(getByTestId('habit-count')).toHaveTextContent('10 / 10');

    fireEvent.press(getByTestId('continue-button'));

    expect(queryByText(/Continue anyway/i)).toBeNull();
    getByText('Energy Cost');
  });
});
