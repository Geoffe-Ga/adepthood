import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Alert } from 'react-native';
import renderer from 'react-test-renderer';

const HabitsScreen = require('../HabitsScreen').default;

/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('../../../api', () => ({
  habits: {
    list: (jest.fn() as any).mockResolvedValue([]),
    create: (jest.fn() as any).mockResolvedValue({}),
    update: jest.fn(),
    delete: jest.fn(),
  },
  goalCompletions: { create: jest.fn() },
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  it('shows next steps alert after saving habits', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderer.act(async () => {
      renderer.create(<HabitsScreen />);
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
    renderer.act(() => {
      props.onSaveHabits([sampleHabit]);
    });
    expect(Alert.alert).toHaveBeenCalledWith('Next steps', 'Tap a habit tile to edit its goals.');
  });
});
