import App from '../App';
import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer from 'react-test-renderer';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'token' }),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
}));

jest.mock('../features/Habits/components/GoalModal', () => () => null);
jest.mock('../features/Habits/components/HabitSettingsModal', () => () => null);
jest.mock('../features/Habits/components/MissedDaysModal', () => () => null);
jest.mock('../features/Habits/components/OnboardingModal', () => () => null);
jest.mock('../features/Habits/components/ReorderHabitsModal', () => () => null);
jest.mock('../features/Habits/components/StatsModal', () => () => null);
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

describe('App bootstrap', () => {
  it('includes SafeAreaProvider at the root', () => {
    const tree = renderer.create(<App />).root;
    expect(tree.findAllByType(SafeAreaProvider).length).toBeGreaterThan(0);
  });

  it('imports react-native-reanimated before app bootstrap', () => {
    const indexPath = path.join(__dirname, '..', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    expect(content.trim().startsWith("import 'react-native-reanimated'")).toBe(true);
  });
});
