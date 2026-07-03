/* eslint-env jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest, describe, afterEach, it, expect } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

import { STAGE_COLORS } from '../../../design/tokens';
import type { Habit } from '../Habits.types';
import { HabitTile } from '../HabitTile';

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

jest.mock('../../../api', () => ({
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
}));

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
  // Allow the post-load reconciliation effects to settle so notification
  // mocks don't trigger unhandled promise rejections.
  await renderer.act(async () => {
    await Promise.resolve();
  });
  return testRenderer;
};

const uniqueTiles = (tree: any): any[] => {
  // ``TouchableOpacity`` forwards testID through wrapper layers, producing
  // multiple matches per tile under ``findAllByProps``. Filter to the
  // composite root (its instance is exactly one per tile).
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

describe('HabitTile stageColor prop', () => {
  const baseHabit: Habit = {
    id: 1,
    stage: 'Purple',
    name: 'Override Test',
    icon: '🎨',
    streak: 0,
    energy_cost: 1,
    energy_return: 1,
    start_date: new Date(2020, 0, 1),
    goals: [
      {
        title: 'Clear',
        tier: 'clear',
        target: 1,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ],
    completions: [],
    revealed: true,
  };

  it('uses the stageColor override on the unlocked tile border', () => {
    const component = renderer.create(
      <HabitTile habit={baseHabit} stageColor="#abcdef" onOpenGoals={() => {}} />,
    );
    const tile = component.root.findByProps({ testID: 'habit-tile' });
    expect(tile.props.style.borderColor).toBe('#abcdef');
  });

  it('uses the stageColor override on the locked tile border', () => {
    const component = renderer.create(
      <HabitTile habit={{ ...baseHabit, revealed: false }} locked stageColor="#123456" />,
    );
    const tile = component.root.findByProps({ testID: 'habit-tile' });
    expect(tile.props.style.borderColor).toBe('#123456');
  });

  it('falls back to STAGE_COLORS[habit.stage] when stageColor is omitted', () => {
    const component = renderer.create(<HabitTile habit={baseHabit} onOpenGoals={() => {}} />);
    const tile = component.root.findByProps({ testID: 'habit-tile' });
    expect(tile.props.style.borderColor).toBe(STAGE_COLORS.Purple);
  });
});

describe('HabitsScreen position-based stage colors', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('paints the first tile Beige and the second tile Purple', async () => {
    const testRenderer = await renderScreen(buildApiHabits(3));
    const tree = testRenderer.root;
    expect(tileBorderAt(tree, 0)).toBe(STAGE_COLORS.Beige);
    expect(tileBorderAt(tree, 1)).toBe(STAGE_COLORS.Purple);
    expect(tileBorderAt(tree, 2)).toBe(STAGE_COLORS.Red);
  });

  it('paints the tenth tile Clear Light at the end of the gradient', async () => {
    const testRenderer = await renderScreen(buildApiHabits(10));
    const tree = testRenderer.root;
    expect(tileBorderAt(tree, 9)).toBe(STAGE_COLORS['Clear Light']);
  });

  it('restarts the Beige → Clear Light sequence on page 2', async () => {
    const testRenderer = await renderScreen(buildApiHabits(12));
    const tree = testRenderer.root;
    expect(tileBorderAt(tree, 0)).toBe(STAGE_COLORS.Beige);
    const nextButton = tree.findByProps({ testID: 'pagination-next' });
    await renderer.act(async () => {
      nextButton.props.onPress();
    });
    expect(tileBorderAt(tree, 0)).toBe(STAGE_COLORS.Beige);
    expect(tileBorderAt(tree, 1)).toBe(STAGE_COLORS.Purple);
  });

  it('colors tiles by list position regardless of habit.stage', async () => {
    // Every API habit has stage "Beige" — without position-based coloring
    // all tiles would render Beige. The renderer must override that.
    const testRenderer = await renderScreen(buildApiHabits(3));
    const tree = testRenderer.root;
    expect(tileBorderAt(tree, 0)).toBe(STAGE_COLORS.Beige);
    expect(tileBorderAt(tree, 1)).toBe(STAGE_COLORS.Purple);
    expect(tileBorderAt(tree, 1)).not.toBe(STAGE_COLORS.Beige);
  });
});
