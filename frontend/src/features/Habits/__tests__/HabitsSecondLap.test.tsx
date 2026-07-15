/* eslint-env jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Second habit set (stages 11-20): once a lap fills every slot, the screen
// offers a trailing invite page into the next lap instead of stranding the
// user on a full first page with no way forward.
import { jest, describe, afterEach, it, expect } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
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

// HabitsScreen now installs its header-left toggle through useAppNavigation
// (useScreenDrawer); mock the navigation hooks module so the screen renders
// outside a real NavigationContainer.
jest.mock('@/navigation/hooks', () => ({
  useAppNavigation: () => ({ setOptions: jest.fn() }),
}));

jest.mock('../../../api', () => {
  // Keep the real ``toLocalHabit`` mapper the load path delegates to; stub only
  // the network namespaces this screen exercises.
  const actual: typeof ApiModule = jest.requireActual('../../../api');
  return {
    ...actual,
    // useHabitUI hydrates the energy-CTA flag server-first via uiFlags.get.
    uiFlags: {
      get: jest.fn(() =>
        Promise.resolve({
          has_seen_welcome: false,
          energy_scaffolding_archived: false,
        }),
      ),
      update: jest.fn(() =>
        Promise.resolve({
          has_seen_welcome: false,
          energy_scaffolding_archived: false,
        }),
      ),
    },
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

const renderScreen = async (apiHabits: ReturnType<typeof buildApiHabits>) => {
  habitsApi.listAll.mockResolvedValue(apiHabits);
  jest
    .spyOn(require('react-native'), 'useWindowDimensions')
    .mockReturnValue({ width: 400, height: 800, scale: 1, fontScale: 1 });
  let testRenderer: any;
  await renderer.act(async () => {
    testRenderer = renderer.create(React.createElement(HabitsScreen));
  });
  await renderer.act(async () => {
    await Promise.resolve();
  });
  return testRenderer;
};

const hasTestId = (tree: any, testID: string): boolean =>
  tree.findAllByProps({ testID }).length > 0;

const visibleTextMatches = (tree: any, pattern: RegExp): boolean =>
  tree.findAllByType(Text).some((node: any) => {
    const children = node.props.children;
    const text = Array.isArray(children) ? children.join('') : String(children ?? '');
    return pattern.test(text);
  });

describe('Habits screen second-lap pagination flow', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows the stage-range pagination bar for a full first lap, invites into the second lap, and returns on Prev', async () => {
    const testRenderer = await renderScreen(buildApiHabits(10));
    const tree = testRenderer.root;

    // A full first lap (10 habits) must show pagination, not just a bare list.
    expect(hasTestId(tree, 'habits-pagination')).toBe(true);
    expect(visibleTextMatches(tree, /Stages\s*1[\s\S]*10/)).toBe(true);

    const nextButton = tree.findByProps({ testID: 'pagination-next' });
    await renderer.act(async () => {
      nextButton.props.onPress();
    });

    // The invite page: no second-lap habits yet, so the range-aware empty
    // state renders, and the pagination bar stays visible (not stranded).
    expect(hasTestId(tree, 'habits-empty-state')).toBe(true);
    expect(hasTestId(tree, 'habits-pagination')).toBe(true);
    expect(visibleTextMatches(tree, /Stages\s*11[\s\S]*20/)).toBe(true);

    const prevButton = tree.findByProps({ testID: 'pagination-prev' });
    await renderer.act(async () => {
      prevButton.props.onPress();
    });

    // Back on the first lap: the list is showing again, not the empty state.
    expect(hasTestId(tree, 'habits-list')).toBe(true);
    expect(hasTestId(tree, 'habits-empty-state')).toBe(false);
  });
});
