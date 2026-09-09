/**
 * The habit tile, across the local day boundary, with nothing remounting it.
 *
 * The day helpers already had tests, and they passed while the reported bug
 * was live (#2764): they call the bucketing directly, so they can never see
 * the actual defect, which is that nothing asks for the bucketing again. The
 * tile is memoised and its props do not change at midnight, so a parent
 * re-render would not reach it either.
 *
 * Hence the shape here: a host component that counts its own renders wraps the
 * tile, its props are built once, and no test ever calls `update`. If the
 * tile's text changes while the host's render count stays at one, the update
 * came from below the memo boundary — the tile re-rendered in place, and it
 * was not remounted, because remounting it would require the host to render
 * again.
 */
import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { AppState } from 'react-native';
import type { NativeEventSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import type { Habit } from '../Habits.types';
import { HabitTile } from '../HabitTile';

import { TierStar } from '@/components/TierStar';

const WEST_TZ = 'America/Los_Angeles';
const EAST_TZ = 'Asia/Tokyo';

/** 2026-02-10 23:50 in Los Angeles, ten minutes before its day turns over. */
const WEST_BEFORE_MIDNIGHT = new Date('2026-02-11T07:50:00.000Z').getTime();
/** 2026-02-11 23:50 in Tokyo, ten minutes before *its* day turns over. */
const EAST_BEFORE_MIDNIGHT = new Date('2026-02-11T14:50:00.000Z').getTime();
const TEN_MINUTES_MS = 600_000;

const goal = (tier: 'low' | 'clear' | 'stretch', target: number) => ({
  title: tier,
  tier,
  target,
  target_unit: 'reps',
  frequency: 1,
  frequency_unit: 'per_day' as const,
  is_additive: true,
});

/** A habit fully completed at `completedAt`, three days into a streak. */
const completedHabit = (completedAt: string): Habit => ({
  id: 7,
  stage: 'Beige',
  name: 'Sit',
  icon: '🧘',
  streak: 3,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2026-01-01T00:00:00.000Z'),
  goals: [goal('low', 1), goal('clear', 2), goal('stretch', 3)],
  completions: [{ id: 'c-1', timestamp: new Date(completedAt), completed_units: 3 }],
  revealed: true,
});

/** `ReactTestRenderer` is a named export, not a namespace on the default one. */
type Renderer = ReturnType<typeof create>;
/** A node in the rendered tree, named structurally as `WaveOverlay.test.tsx` does. */
type Node = ReturnType<Renderer['root']['findAll']>[number];

interface Mounted {
  tree: Renderer;
  hostRenders: () => number;
}

/** Mount one tile under a host that records how often it rendered. */
const mountTile = (habit: Habit, tz: string): Mounted => {
  let renders = 0;
  const Host = (): React.JSX.Element => {
    renders += 1;
    return <HabitTile habit={habit} tz={tz} stageColor="#123456" />;
  };
  let tree!: Renderer;
  act(() => {
    tree = create(<Host />);
  });
  return { tree, hostRenders: () => renders };
};

/** The tile's streak line, e.g. `"3 DAYS — ACHIEVED TODAY!"`. */
const streakLine = (tree: Renderer): string =>
  tree.root
    .findAll((node: Node) => typeof node.props.children === 'string')
    .map((node: Node) => node.props.children as string)
    .find((text: string) => text.includes('DAYS')) ?? '';

/** Whether each tier chip is lit, keyed by tier. */
const litChips = (tree: Renderer): Record<string, boolean> =>
  Object.fromEntries(
    tree.root
      .findAllByType(TierStar)
      .map((star: Node) => [star.props.tier, star.props.met === true]),
  );

describe('HabitTile across the day boundary', () => {
  beforeEach(() => {
    jest.spyOn(AppState, 'addEventListener').mockImplementation(
      () =>
        ({
          remove: () => undefined,
        }) as NativeEventSubscription,
    );
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Ahead of the root-level drain in `jest.setup.js`, which would otherwise
    // fire the armed rollover into a tree already being torn down.
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shows a habit finished last night as done right up to local midnight', () => {
    jest.setSystemTime(WEST_BEFORE_MIDNIGHT);
    const { tree } = mountTile(completedHabit('2026-02-11T07:30:00.000Z'), WEST_TZ);

    expect(streakLine(tree)).toBe('3 DAYS — ACHIEVED TODAY!');
    expect(litChips(tree)).toEqual({ low: true, clear: true, stretch: true });
  });

  it('returns it to not-done-today at local midnight, without a remount', () => {
    jest.setSystemTime(WEST_BEFORE_MIDNIGHT);
    const { tree, hostRenders } = mountTile(completedHabit('2026-02-11T07:30:00.000Z'), WEST_TZ);
    expect(hostRenders()).toBe(1);

    act(() => {
      jest.advanceTimersByTime(TEN_MINUTES_MS);
    });

    expect(streakLine(tree)).toBe('3 DAYS');
    expect(litChips(tree)).toEqual({ low: false, clear: false, stretch: false });
    // Nothing above the tile re-rendered, so nothing above it could have
    // remounted it: the tile updated itself in place.
    expect(hostRenders()).toBe(1);
  });

  it('holds the done state through the minutes before the boundary', () => {
    jest.setSystemTime(WEST_BEFORE_MIDNIGHT);
    const { tree } = mountTile(completedHabit('2026-02-11T07:30:00.000Z'), WEST_TZ);

    act(() => {
      jest.advanceTimersByTime(TEN_MINUTES_MS - 60_000);
    });

    expect(streakLine(tree)).toBe('3 DAYS — ACHIEVED TODAY!');
  });

  it('turns over at the user zone east of UTC, not at UTC midnight', () => {
    // UTC midnight arrives 9h10m from here; Tokyo's is ten minutes away.
    jest.setSystemTime(EAST_BEFORE_MIDNIGHT);
    const { tree, hostRenders } = mountTile(completedHabit('2026-02-11T14:30:00.000Z'), EAST_TZ);
    expect(streakLine(tree)).toBe('3 DAYS — ACHIEVED TODAY!');

    act(() => {
      jest.advanceTimersByTime(TEN_MINUTES_MS);
    });

    expect(streakLine(tree)).toBe('3 DAYS');
    expect(hostRenders()).toBe(1);
  });

  it('leaves a habit completed after the boundary alone', () => {
    // Logged at 00:05 on the 11th in Los Angeles — today, not last night.
    jest.setSystemTime(new Date('2026-02-11T08:20:00.000Z').getTime());
    const { tree } = mountTile(completedHabit('2026-02-11T08:05:00.000Z'), WEST_TZ);

    act(() => {
      jest.advanceTimersByTime(TEN_MINUTES_MS);
    });

    expect(streakLine(tree)).toBe('3 DAYS — ACHIEVED TODAY!');
  });

  it('never rewrites the completion it stopped counting', () => {
    const habit = completedHabit('2026-02-11T07:30:00.000Z');
    jest.setSystemTime(WEST_BEFORE_MIDNIGHT);
    mountTile(habit, WEST_TZ);

    act(() => {
      jest.advanceTimersByTime(TEN_MINUTES_MS);
    });

    expect(habit.completions).toEqual([
      { id: 'c-1', timestamp: new Date('2026-02-11T07:30:00.000Z'), completed_units: 3 },
    ]);
  });
});
