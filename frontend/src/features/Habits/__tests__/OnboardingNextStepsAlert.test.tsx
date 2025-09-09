/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Alert } from 'react-native';
import renderer from 'react-test-renderer';

const HabitsScreen = require('../HabitsScreen').default;

const mockOnboardingModal = jest.fn();
jest.mock('../components/OnboardingModal', () => (props: any) => {
  mockOnboardingModal(props);
  return null;
});
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/StatsModal', () => () => null);

jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (jest.fn() as any).mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn() as any,
  scheduleNotificationAsync: jest.fn() as any,
  cancelScheduledNotificationAsync: jest.fn() as any,
  getExpoPushTokenAsync: (jest.fn() as any).mockResolvedValue({ data: 'token' }),
}));
jest.mock('../../../api/habits', () => ({
  getHabits: (jest.fn() as any).mockResolvedValue([]),
  createHabit: (jest.fn() as any).mockResolvedValue({
    id: 1,
    stage: 'Beige',
    name: 'Test',
    icon: '⭐',
    streak: 0,
    energy_cost: 1,
    energy_return: 2,
    start_date: new Date(),
    goals: [],
  }),
  updateHabit: jest.fn(),
  deleteHabit: jest.fn(),
}));

describe('Onboarding completion', () => {
  it('shows next steps alert after saving habits', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    renderer.create(<HabitsScreen />);
    const call = mockOnboardingModal.mock.calls[0];
    if (!call) throw new Error('OnboardingModal not rendered');
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
      await props.onSaveHabits([sampleHabit]);
    });
    expect(Alert.alert).toHaveBeenCalledWith('Next steps', 'Tap a habit tile to edit its goals.');
  });
});
