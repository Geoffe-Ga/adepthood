import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

import { ToastProvider } from '../../../components/ToastProvider';

const HabitsScreen = require('../HabitsScreen').default;

/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('../../../api', () => ({
  habits: {
    list: (jest.fn() as any).mockResolvedValue([]),
    create: (jest.fn() as any).mockResolvedValue({}),
    update: jest.fn(),
    delete: jest.fn(),
    getStats: (jest.fn() as any).mockResolvedValue({
      day_labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      values: [0, 0, 0, 0, 0, 0, 0],
      completions_by_day: [0, 0, 0, 0, 0, 0, 0],
      longest_streak: 0,
      current_streak: 0,
      total_completions: 0,
      completion_rate: 0,
      completion_dates: [],
    }),
  },
  goalCompletions: { create: jest.fn() },
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

const mockOnboardingModal = jest.fn();
jest.mock('../components/OnboardingModal', () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (props: any) => {
    mockOnboardingModal(props);
    return null;
  },
);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/StatsModal', () => () => null);

jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
}));

describe('Onboarding completion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    renderer.act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('shows next steps toast after saving habits', async () => {
    let root: ReturnType<typeof renderer.create>;
    await renderer.act(async () => {
      root = renderer.create(
        <ToastProvider>
          <HabitsScreen />
        </ToastProvider>,
      );
    });
    const call = mockOnboardingModal.mock.calls[0];
    if (!call) throw new Error('OnboardingModal not rendered');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = call[0] as any;
    const sampleHabit = {
      name: 'Test',
      icon: '⭐',
      energy_cost: 1,
      energy_return: 2,
      stage: 'Beige',
      start_date: new Date(),
    };
    await renderer.act(async () => {
      props.onSaveHabits([sampleHabit]);
    });
    // Verify toast is rendered with the instructional message
    const toastMessage = root!.root.findAllByProps({ testID: 'toast-message' });
    expect(toastMessage.length).toBeGreaterThan(0);
    expect(toastMessage[0].props.children).toBe('Tap a habit tile to edit its goals.');
  });
});
