import { describe, expect, it, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';
import { TextInput } from 'react-native';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../HabitsScreen', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  Gesture: {
    LongPress: () => ({ minDuration: () => ({ onStart: () => ({}) }) }),
    Pan: () => ({ activateAfterLongPress: () => ({ onBegin: () => ({}) }) }),
    Race: () => ({}),
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  View: require('react-native').View,
}));

describe('OnboardingModal Step 1 interactions', () => {
  it('Enter adds habit, clears input, refocuses input', () => {
    const focusSpy = jest.spyOn(TextInput.prototype, 'focus');
    const { getByPlaceholderText, getByText } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, 'Drink water');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    getByText('⭐ Drink water');
    expect(input.props.value).toBe('');
    expect(focusSpy).toHaveBeenCalled();
  });

  it('Cmd+Enter triggers next step when habit exists', () => {
    const { getByPlaceholderText, getByText } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, 'Read');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter', metaKey: true } });
    getByText('Energy Cost');
  });

  it('adding more than 10 habits shows error and keeps count', () => {
    const { getByPlaceholderText, getByTestId, getByText } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    for (let i = 0; i < 10; i++) {
      fireEvent.changeText(input, `H${i}`);
      fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    }
    expect(getByTestId('habit-count')).toHaveTextContent('10 / 10');
    fireEvent.changeText(input, 'H10');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    getByText('You can only add up to 10 habits.');
    expect(getByTestId('habit-count')).toHaveTextContent('10 / 10');
  });

  it('Continue with fewer than 10 habits shows warning then advances', () => {
    const { getByPlaceholderText, getByTestId, getByText } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    for (let i = 0; i < 3; i++) {
      fireEvent.changeText(input, `H${i}`);
      fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    }
    fireEvent.press(getByTestId('continue-button'));
    getByText("You've entered 3 of 10. Continue anyway?");
    fireEvent.press(getByTestId('count-warning-continue'));
    getByText('Energy Cost');
  });
});
