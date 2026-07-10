/* eslint-env jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
// The in-body pagination bar is now optional: a persisted "hidden" flag
// (toggled from the header drawer) must suppress it even on a full lap
// that would otherwise show it.
import { jest, describe, afterEach, it, expect } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

import type * as ApiModule from '../../../api';

const makeApiHabit = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Habit ${id}`,
  icon: '✨',
  start_date: '2020-01-01',
  energy_cost: 1,
  energy_return: 2,
  stage: 'Beige',
  streak: 0,
  goals: [
    {
      id: id * 100,
      habit_id: id,
      title: 'Clear',
      tier: 'clear',
      target: 1,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ],
  ...overrides,
});

const buildApiHabits = (count: number) =>
  Array.from({ length: count }, (_, i) => makeApiHabit(i + 1, { sort_order: i }));

jest.mock('@/navigation/hooks', () => ({
  useAppNavigation: () => ({ setOptions: jest.fn() }),
}));

// This test targets HabitsScreen's pagination-gating behavior, not the storage
// module itself (covered separately in paginationVisibilityStorage.test.ts), so
// the module is mocked to report the bar as persisted-hidden.
jest.mock('../../../storage/paginationVisibilityStorage', () => ({
  loadPaginationBarHidden: jest.fn(() => Promise.resolve(true)),
  savePaginationBarHidden: jest.fn(() => Promise.resolve(undefined)),
}));

jest.mock('../../../api', () => {
  const actual: typeof ApiModule = jest.requireActual('../../../api');
  return {
    ...actual,
    habits: {
      listAll: jest.fn() as any,
      create: jest.fn() as any,
      update: jest.fn() as any,
      delete: jest.fn() as any,
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
    goalCompletions: { create: jest.fn() as any },
  };
});

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (jest.fn() as any).mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn() as any,
  scheduleNotificationAsync: jest.fn() as any,
  cancelScheduledNotificationAsync: jest.fn() as any,
  getExpoPushTokenAsync: (jest.fn() as any).mockResolvedValue({ data: 'token' }),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactLib = require('react');
  return {
    SafeAreaView: ({ children }: { children: any }) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../components/AddHabitModal', () => () => null);
jest.mock('../components/GoalModal', () => () => null);
jest.mock('../components/HabitSettingsModal', () => () => null);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/StatsModal', () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

const { habits: habitsApi } = require('../../../api');
const HabitsScreen = require('../HabitsScreen').default;

const hasTestId = (tree: any, testID: string): boolean =>
  tree.findAllByProps({ testID }).length > 0;

describe('Habits screen pagination-bar visibility', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('hides the in-body pagination bar when the hidden flag was persisted, even on a full lap', async () => {
    habitsApi.listAll.mockResolvedValue(buildApiHabits(10));
    jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({ width: 400, height: 800, scale: 1, fontScale: 1 });

    let testRenderer: any;
    await renderer.act(async () => {
      testRenderer = renderer.create(React.createElement(HabitsScreen));
    });
    // Both the habit load and the persisted-hidden flag resolve asynchronously;
    // flush pending microtasks until the bar is gone (bounded so a genuine
    // regression that never hides it still fails rather than hangs).
    for (
      let attempt = 0;
      attempt < 10 && hasTestId(testRenderer.root, 'habits-pagination');
      attempt += 1
    ) {
      await renderer.act(async () => {
        await Promise.resolve();
      });
    }

    expect(hasTestId(testRenderer.root, 'habits-pagination')).toBe(false);
  });
});
