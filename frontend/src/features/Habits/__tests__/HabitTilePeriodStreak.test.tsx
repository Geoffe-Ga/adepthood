/**
 * The tile's streak line for weekly and monthly habits.
 *
 * `habit.streak` is the server's period count; the `done/needed` fraction is
 * derived locally from the habit's completions in the tile's zone.
 */
import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { AppState } from 'react-native';
import type { NativeEventSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import type { Goal, Habit } from '../Habits.types';
import { HabitTile } from '../HabitTile';

/** Wednesday 2026-06-17, 18:00 UTC. */
const NOW = new Date('2026-06-17T18:00:00Z').getTime();

const goal = (
  tier: Goal['tier'],
  target: number,
  frequency: number,
  frequencyUnit: string,
): Goal => ({
  title: tier,
  tier,
  target,
  target_unit: 'reps',
  frequency,
  frequency_unit: frequencyUnit,
  is_additive: true,
});

const row = (day: string, units: number) => ({
  id: day,
  timestamp: new Date(`${day}T12:00:00Z`),
  local_day: day,
  completed_units: units,
});

const habitWith = (overrides: Partial<Habit>): Habit => ({
  id: 7,
  stage: 'Beige',
  name: 'Sit',
  icon: '🧘',
  streak: 2,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2026-01-01T00:00:00.000Z'),
  goals: [
    goal('low', 1, 4, 'per_week'),
    goal('clear', 2, 4, 'per_week'),
    goal('stretch', 3, 4, 'per_week'),
  ],
  completions: [],
  revealed: true,
  ...overrides,
});

type Renderer = ReturnType<typeof create>;
type Node = ReturnType<Renderer['root']['findAll']>[number];

const streakLine = (tree: Renderer): string =>
  tree.root
    .findAll((node: Node) => typeof node.props.children === 'string')
    .map((node: Node) => node.props.children as string)
    .find((text: string) => text.includes('DAYS')) ?? '';

const mount = (habit: Habit): Renderer => {
  let tree!: Renderer;
  act(() => {
    tree = create(<HabitTile habit={habit} tz="UTC" stageColor="#123456" />);
  });
  return tree;
};

describe('HabitTile period streak label', () => {
  beforeEach(() => {
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(() => ({ remove: () => undefined }) as NativeEventSubscription);
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shows the week streak and this week’s done days', () => {
    const tree = mount(habitWith({ completions: [row('2026-06-15', 1), row('2026-06-16', 1)] }));
    expect(streakLine(tree)).toBe('2 WEEKS · 2/4 DAYS');
  });

  it('uses the singular for one week and appends the achieved suffix', () => {
    const tree = mount(
      habitWith({
        streak: 1,
        completions: [row('2026-06-15', 1), row('2026-06-16', 1), row('2026-06-17', 3)],
      }),
    );
    expect(streakLine(tree)).toBe('1 WEEK · 3/4 DAYS — ACHIEVED TODAY!');
  });

  it('shows months for a per_month low tier', () => {
    const tree = mount(
      habitWith({
        streak: 3,
        goals: [
          goal('low', 1, 10, 'per_month'),
          goal('clear', 2, 10, 'per_month'),
          goal('stretch', 3, 10, 'per_month'),
        ],
        completions: [row('2026-05-30', 1), row('2026-06-01', 1), row('2026-06-02', 0)],
      }),
    );
    expect(streakLine(tree)).toBe('3 MONTHS · 1/10 DAYS');
  });

  it('keeps the daily label for a per_day habit', () => {
    const tree = mount(
      habitWith({
        streak: 3,
        goals: [
          goal('low', 1, 1, 'per_day'),
          goal('clear', 2, 1, 'per_day'),
          goal('stretch', 3, 1, 'per_day'),
        ],
      }),
    );
    expect(streakLine(tree)).toBe('3 DAYS');
  });
});
