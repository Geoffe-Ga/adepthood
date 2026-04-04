/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { NavigationContainer } from '@react-navigation/native';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

const mockLogout = jest.fn(() => Promise.resolve());

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ logout: mockLogout }),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'token' }),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
}));

jest.mock('@/features/Habits/components/GoalModal', () => () => null);
jest.mock('@/features/Habits/components/HabitSettingsModal', () => () => null);
jest.mock('@/features/Habits/components/MissedDaysModal', () => () => null);
jest.mock('@/features/Habits/components/OnboardingModal', () => () => null);
jest.mock('@/features/Habits/components/ReorderHabitsModal', () => () => null);
jest.mock('@/features/Habits/components/StatsModal', () => () => null);
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

import BottomTabs from '../BottomTabs';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BottomTabs', () => {
  it('renders a logout button in the header', () => {
    const { getByText } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(getByText('Logout')).toBeTruthy();
  });

  it('calls logout when the logout button is pressed', () => {
    const { getByText } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    fireEvent.press(getByText('Logout'));
    expect(mockLogout).toHaveBeenCalled();
  });
});
