import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

// The onboarding counter must be built from the shared MAX_HABITS constant, not
// a repeated literal. Mock the constant to a value distinct from its real 10 so
// a hardcoded "/ 10" would render the wrong number and fail this test.
jest.mock('../../constants', () => ({
  ...(jest.requireActual('../../constants') as Record<string, unknown>),
  DEFAULT_ICONS: ['⭐'],
  MAX_HABITS: 7,
}));
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
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

const OnboardingModal = require('../OnboardingModal').default;
const { MAX_HABITS } = require('../../constants') as { MAX_HABITS: number };

describe('OnboardingModal habit-ceiling derivation', () => {
  it('renders the habit counter denominator from the MAX_HABITS constant', () => {
    const { getByTestId } = render(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    expect(getByTestId('habit-count')).toHaveTextContent(`0 / ${MAX_HABITS}`);
    expect(MAX_HABITS).not.toBe(10);
  });
});
