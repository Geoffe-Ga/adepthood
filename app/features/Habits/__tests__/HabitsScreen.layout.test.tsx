/* eslint-disable import/order, @typescript-eslint/no-explicit-any */
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';
import HabitsScreen from '../HabitsScreen';

void React;

// Mock external modules
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (jest.fn() as any).mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn() as any,
  getExpoPushTokenAsync: (jest.fn() as any).mockResolvedValue({ data: 'token' }),
  scheduleNotificationAsync: jest.fn() as any,
  cancelScheduledNotificationAsync: jest.fn() as any,
}));

jest.mock('../components/GoalModal', () => () => null);
jest.mock('../components/HabitSettingsModal', () => () => null);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/StatsModal', () => () => null);

// Force responsive hook to a predictable grid
jest.mock('../../../Sources/design/useResponsive', () => () => ({
  columns: 2,
  gridGutter: 0,
  scale: 1,
  width: 400,
  height: 800,
  isLG: false,
  isXL: false,
}));

describe('HabitsScreen layout', () => {
  it('renders habits bottom-up with reversed rows and columns', () => {
    const tree = renderer.create(<HabitsScreen />).root;
    const list = tree.findByProps({ testID: 'habits-list' });
    const contentStyle = Array.isArray(list.props.contentContainerStyle)
      ? Object.assign({}, ...list.props.contentContainerStyle)
      : list.props.contentContainerStyle;
    expect(contentStyle.flexDirection).toBe('column-reverse');
    expect(list.props.columnWrapperStyle.flexDirection).toBe('row-reverse');
  });
});
