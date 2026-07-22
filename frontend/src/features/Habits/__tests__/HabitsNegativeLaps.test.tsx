/* eslint-env jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Carryover habits render on signed negative laps ("-10 to -1", then
// "-20 to -11") that sit before the positive program lap 1-10; a deeper
// negative lap opens only when the shallower one holds exactly ten carryover
// habits (leading-invite mirror of the trailing invite page).
import { jest, describe, afterEach, it, expect } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import renderer from 'react-test-renderer';

import type * as ApiModule from '../../../api';
import { STAGE_COLORS } from '../../../design/tokens';

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

const buildProgramHabits = (count: number) =>
  Array.from({ length: count }, (_, i) => makeApiHabit(i + 1, { sort_order: i }));

const CARRYOVER_ID_BASE = 100;

const buildCarryoverHabits = (count: number, sortBase = 0) =>
  Array.from({ length: count }, (_, i) =>
    makeApiHabit(CARRYOVER_ID_BASE + i, { sort_order: sortBase + i, is_carryover: true }),
  );

// HabitsScreen installs its header-left toggle via useAppNavigation; mock the
// navigation hooks so the screen renders outside a real NavigationContainer.
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

const renderScreen = async (apiHabits: Array<ReturnType<typeof makeApiHabit>>) => {
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

const uniqueTiles = (tree: any): any[] => {
  // TouchableOpacity forwards testID through wrapper layers; filter to the
  // composite root so each tile counts exactly once.
  const { TouchableOpacity } = require('react-native');
  return tree
    .findAllByType(TouchableOpacity)
    .filter((node: any) => node.props.testID === 'habit-tile');
};

const tileBorderAt = (tree: any, index: number): string => {
  const tile = uniqueTiles(tree)[index];
  const style = Array.isArray(tile.props.style)
    ? tile.props.style.reduce((acc: any, s: any) => ({ ...acc, ...s }), {})
    : tile.props.style;
  return style.borderColor as string;
};

const paginationButton = (tree: any, testID: string): any => {
  const { TouchableOpacity } = require('react-native');
  return tree.findAllByType(TouchableOpacity).find((node: any) => node.props.testID === testID);
};

const pressPrev = async (tree: any) => {
  const prev = paginationButton(tree, 'pagination-prev');
  expect(prev).toBeDefined();
  await renderer.act(async () => {
    prev.props.onPress();
  });
};

describe('Habits screen negative carryover laps', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows the program lap first, then Prev steps onto the -10 to -1 carryover lap', async () => {
    const apiHabits = [
      makeApiHabit(1, { sort_order: 0 }),
      makeApiHabit(101, { sort_order: 1, is_carryover: true }),
      makeApiHabit(2, { sort_order: 2 }),
      makeApiHabit(102, { sort_order: 3, is_carryover: true }),
      makeApiHabit(3, { sort_order: 4 }),
    ];
    const testRenderer = await renderScreen(apiHabits);
    const tree = testRenderer.root;

    // Initial render is the program lap: three program tiles, no negative range.
    expect(visibleTextMatches(tree, /Stages\s*1[\s\S]*10/)).toBe(true);
    expect(visibleTextMatches(tree, /-10 to -1/)).toBe(false);
    expect(uniqueTiles(tree)).toHaveLength(3);

    await pressPrev(tree);

    expect(visibleTextMatches(tree, /-10 to -1/)).toBe(true);
    expect(uniqueTiles(tree)).toHaveLength(2);
  });

  it('keeps Prev disabled on page 0 when there are no carryover habits', async () => {
    const testRenderer = await renderScreen(buildProgramHabits(10));
    const tree = testRenderer.root;

    expect(hasTestId(tree, 'habits-pagination')).toBe(true);
    const prev = paginationButton(tree, 'pagination-prev');
    expect(prev.props.accessibilityState.disabled).toBe(true);
    expect(visibleTextMatches(tree, /-10 to -1/)).toBe(false);
  });

  it('opens a -20 to -11 leading-invite lap when exactly ten carryover habits fill the first negative lap', async () => {
    const testRenderer = await renderScreen(buildCarryoverHabits(10));
    const tree = testRenderer.root;

    await pressPrev(tree);
    expect(visibleTextMatches(tree, /-10 to -1/)).toBe(true);
    expect(uniqueTiles(tree)).toHaveLength(10);

    await pressPrev(tree);
    expect(visibleTextMatches(tree, /-20 to -11/)).toBe(true);
    expect(hasTestId(tree, 'habits-empty-state')).toBe(true);
  });

  it('does not open a deeper lap for a partial carryover lap: Prev is disabled on -10 to -1', async () => {
    const apiHabits = [...buildProgramHabits(2), ...buildCarryoverHabits(3, 2)];
    const testRenderer = await renderScreen(apiHabits);
    const tree = testRenderer.root;

    await pressPrev(tree);
    expect(visibleTextMatches(tree, /-10 to -1/)).toBe(true);

    const prev = paginationButton(tree, 'pagination-prev');
    expect(prev.props.accessibilityState.disabled).toBe(true);
    expect(visibleTextMatches(tree, /-20 to -11/)).toBe(false);
  });

  it('paints the negative lap with the re-anchored gradient: slot -1 Clear Light, slot -10 Beige', async () => {
    // Every API habit is stage Beige; position-based coloring must override it.
    const testRenderer = await renderScreen(buildCarryoverHabits(10));
    const tree = testRenderer.root;

    await pressPrev(tree);
    expect(uniqueTiles(tree)).toHaveLength(10);

    expect(tileBorderAt(tree, 0)).toBe(STAGE_COLORS['Clear Light']);
    expect(tileBorderAt(tree, 9)).toBe(STAGE_COLORS.Beige);

    const borders = uniqueTiles(tree).map((_: any, i: number) => tileBorderAt(tree, i));
    expect(new Set(borders).size).toBeGreaterThan(1);
  });
});
