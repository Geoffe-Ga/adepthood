import { describe, it, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../constants', () => ({ DEFAULT_ICONS: ['⭐'] }));
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

describe('OnboardingModal Ctrl+Enter shortcut', () => {
  it('advances to the cost step on Ctrl+Enter, not just Cmd+Enter', () => {
    const { getByPlaceholderText, getByText } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const input = getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, 'Read');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter', ctrlKey: true } });
    getByText('Energy Cost');
  });
});
