import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { goalGroups as goalGroupsApi } from '../../../../api';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../constants', () => ({ DEFAULT_ICONS: ['⭐'] }));
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
// Only the header/footer slots matter here (no test in this file interacts
// with an individual reorder row), so the mock skips ``renderItem`` and the
// drag wiring entirely rather than reproducing the full fixture used by the
// reorder-focused suites.
jest.mock('react-native-draggable-flatlist', () => {
  const { View } = require('react-native');
  return function MockDraggableFlatList({
    testID,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    testID?: string;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) {
    return (
      <View testID={testID}>
        {ListHeaderComponent}
        {ListFooterComponent}
      </View>
    );
  };
});
jest.mock('../../../../api', () => ({
  goalGroups: { list: jest.fn() },
}));

const mockList = goalGroupsApi.list as jest.MockedFunction<typeof goalGroupsApi.list>;

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

describe('OnboardingModal handleGoToTemplates stale-request guard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('drops the stale success response when continue is tapped twice before the first resolves', async () => {
    mockList.mockResolvedValue([
      { id: 1, name: 'Meditation Goals', icon: '🧘', shared_template: true, goals: [] },
    ]);
    const onSave = jest.fn();
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={onSave} />);
    advanceToTemplatesGate(result);

    const button = result.getByTestId('continue-to-templates');
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
      await jest.advanceTimersByTimeAsync(10);
    });

    // Both taps resolve, but the stale first response must not be allowed
    // to route the user anywhere other than the current (second) request.
    expect(result.getByTestId('finish-setup')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('drops the stale failure response when continue is tapped twice and both fetches fail', async () => {
    mockList.mockRejectedValue(new Error('network down'));
    const onSave = jest.fn();
    const onClose = jest.fn();
    const result = render(<OnboardingModal visible onClose={onClose} onSaveHabits={onSave} />);
    advanceToTemplatesGate(result);

    const button = result.getByTestId('continue-to-templates');
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
      await jest.advanceTimersByTimeAsync(10);
    });

    // Without the stale-request guard, the fallback save-and-close path
    // would fire once per in-flight request instead of once overall.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
