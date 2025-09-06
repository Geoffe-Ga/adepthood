/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from 'path';

import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer from 'react-test-renderer';

import App from '../src/App';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (jest.fn() as any).mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn() as any,
  getExpoPushTokenAsync: (jest.fn() as any).mockResolvedValue({ data: 'token' }),
  scheduleNotificationAsync: jest.fn() as any,
  cancelScheduledNotificationAsync: jest.fn() as any,
}));

jest.mock('../src/features/Habits/components/GoalModal', () => () => null);
jest.mock('../src/features/Habits/components/HabitSettingsModal', () => () => null);
jest.mock('../src/features/Habits/components/MissedDaysModal', () => () => null);
jest.mock('../src/features/Habits/components/OnboardingModal', () => () => null);
jest.mock('../src/features/Habits/components/ReorderHabitsModal', () => () => null);
jest.mock('../src/features/Habits/components/StatsModal', () => () => null);
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

describe('App bootstrap', () => {
  it('includes SafeAreaProvider at the root', () => {
    const tree = renderer.create(<App />).root;
    expect(tree.findAllByType(SafeAreaProvider).length).toBeGreaterThan(0);
  });

  it('imports react-native-reanimated before app bootstrap', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    expect(content.trim().startsWith("import 'react-native-reanimated'")).toBe(true);
  });
});
