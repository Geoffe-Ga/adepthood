/* eslint-env jest */
/* global describe, it, expect, jest */
/* eslint-disable import/order */
import React from 'react';
import renderer from 'react-test-renderer';

import { HabitTile } from '../HabitTile';
import type { Habit } from '../Habits.types';

const habit: Habit = {
  id: 1,
  stage: 'Beige',
  name: 'Water',
  icon: '💧',
  streak: 0,
  energy_cost: 0,
  energy_return: 0,
  start_date: new Date(),
  goals: [
    {
      title: 'Low',
      tier: 'low',
      target: 10,
      target_unit: 'oz',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      title: 'Clear',
      tier: 'clear',
      target: 20,
      target_unit: 'oz',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      title: 'Stretch',
      tier: 'stretch',
      target: 30,
      target_unit: 'oz',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ],
  completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 5 }],
};

describe('HabitTile tooltips', () => {
  it('shows tooltip on hover', () => {
    const component = renderer.create(
      <HabitTile habit={habit} onOpenGoals={() => {}} onLongPress={() => {}} />,
    );

    const marker = component.root.findByProps({ testID: 'marker-clear' });
    expect(() => component.root.findByProps({ testID: 'tooltip-clear' })).toThrow();
    renderer.act(() => {
      marker.props.onMouseEnter();
    });
    expect(component.root.findByProps({ testID: 'tooltip-clear' })).toBeTruthy();
    renderer.act(() => {
      marker.props.onMouseLeave();
    });
    expect(() => component.root.findByProps({ testID: 'tooltip-clear' })).toThrow();
  });
});

// The tooltip, marker, and bar must all score the same account-local period.
describe('HabitTile tooltip fraction matches period scoring', () => {
  const readTooltipFraction = (
    component: ReturnType<typeof renderer.create>,
    tier: string,
  ): { numerator: number; denominator: number } => {
    const bubble = component.root.findByProps({ testID: `tooltip-${tier}` });
    const text = bubble.findByType('Text' as unknown as React.ComponentType);
    const children = text.props.children as unknown;
    const rendered = Array.isArray(children) ? children.join('') : String(children);
    const match = /:\s*([\d.]+)\/([\d.]+)/.exec(rendered);
    if (!match) throw new Error(`no fraction in tooltip: ${rendered}`);
    return { numerator: Number(match[1]), denominator: Number(match[2]) };
  };

  it('keeps a Monday log at one of three through Friday without filling the star', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-13T12:00:00Z')); // Friday
    const perWeek: Habit = {
      ...habit,
      goals: [
        {
          ...habit.goals[0]!,
          target: 1,
          target_unit: 'sessions',
          frequency: 3,
          frequency_unit: 'per_week',
        },
        {
          ...habit.goals[1]!,
          target: 2,
          target_unit: 'sessions',
          frequency: 3,
          frequency_unit: 'per_week',
        },
        {
          ...habit.goals[2]!,
          target: 3,
          target_unit: 'sessions',
          frequency: 3,
          frequency_unit: 'per_week',
        },
      ],
      completions: [
        {
          id: 'w-1',
          timestamp: new Date('2000-01-01T00:00:00Z'),
          local_day: '2026-03-09',
          completed_units: 1,
        },
      ],
    };
    try {
      const component = renderer.create(
        <HabitTile habit={perWeek} onOpenGoals={() => {}} tz="UTC" />,
      );
      const marker = component.root.findByProps({ testID: 'marker-low' });
      expect(() => marker.findByProps({ met: true })).toThrow();
      renderer.act(() => {
        marker.props.onMouseEnter();
      });
      expect(readTooltipFraction(component, 'low')).toEqual({ numerator: 1, denominator: 3 });
    } finally {
      jest.useRealTimers();
    }
  });
});

// All three tier markers visible whenever the goal exists (no ``hasCleared`` gate).
describe('HabitTile markers', () => {
  it('renders all three tier markers at zero progress', () => {
    const fresh: Habit = { ...habit, completions: [] };
    const component = renderer.create(<HabitTile habit={fresh} onOpenGoals={() => {}} />);
    expect(component.root.findByProps({ testID: 'marker-low' })).toBeTruthy();
    expect(component.root.findByProps({ testID: 'marker-clear' })).toBeTruthy();
    expect(component.root.findByProps({ testID: 'marker-stretch' })).toBeTruthy();
  });

  it('renders all three tier markers at full progress', () => {
    const completed: Habit = {
      ...habit,
      completions: [{ id: 'c-99', timestamp: new Date(), completed_units: 30 }],
    };
    const component = renderer.create(<HabitTile habit={completed} onOpenGoals={() => {}} />);
    expect(component.root.findByProps({ testID: 'marker-low' })).toBeTruthy();
    expect(component.root.findByProps({ testID: 'marker-clear' })).toBeTruthy();
    expect(component.root.findByProps({ testID: 'marker-stretch' })).toBeTruthy();
  });

  it('renders all three tier markers for a subtractive habit', () => {
    const subtractive: Habit = {
      ...habit,
      goals: [
        { ...habit.goals[0]!, target: 10, is_additive: false },
        { ...habit.goals[1]!, target: 5, is_additive: false },
        { ...habit.goals[2]!, target: 2, is_additive: false },
      ],
      completions: [],
    };
    const component = renderer.create(<HabitTile habit={subtractive} onOpenGoals={() => {}} />);
    expect(component.root.findByProps({ testID: 'marker-low' })).toBeTruthy();
    expect(component.root.findByProps({ testID: 'marker-clear' })).toBeTruthy();
    expect(component.root.findByProps({ testID: 'marker-stretch' })).toBeTruthy();
  });
});

// User-visible symptom of the daily-reset bug: the streak chip read
// "...— Achieved Today!" the morning after a stretch-goal was met,
// before the user logged anything new. The fix is anchored at the
// progress-utility layer, so render-test the chip text to keep the
// regression nailed at the UI boundary too.
describe('HabitTile achieved-today banner does not leak across days', () => {
  const yesterday = (): Date => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(12, 0, 0, 0);
    return d;
  };

  const findChipText = (component: ReturnType<typeof renderer.create>): string => {
    const header = component.root.findByProps({ testID: 'habit-header' });
    // The chip is the second Text child of the header row.
    const texts = header.findAllByType('Text' as unknown as React.ComponentType);
    return texts
      .map((t: { props: { children: unknown } }) => {
        const children = t.props.children;
        return Array.isArray(children) ? children.join('') : String(children);
      })
      .join('|');
  };

  it("does not show 'Achieved Today!' when only yesterday hit the stretch goal", () => {
    const stretchedYesterday: Habit = {
      ...habit,
      streak: 7,
      // 60 oz logged yesterday is well past the 30 oz stretch target.
      completions: [{ id: 'y-1', timestamp: yesterday(), completed_units: 60 }],
    };
    const component = renderer.create(
      <HabitTile habit={stretchedYesterday} onOpenGoals={() => {}} tz="UTC" />,
    );
    // The chip is rendered upper-cased; match insensitively.
    expect(findChipText(component).toLowerCase()).not.toContain('achieved today');
  });

  it("shows 'Achieved Today!' when today's logs hit the stretch goal", () => {
    const stretchedToday: Habit = {
      ...habit,
      streak: 8,
      completions: [
        { id: 'y-1', timestamp: yesterday(), completed_units: 60 },
        { id: 't-1', timestamp: new Date(), completed_units: 30 },
      ],
    };
    const component = renderer.create(
      <HabitTile habit={stretchedToday} onOpenGoals={() => {}} tz="UTC" />,
    );
    expect(findChipText(component).toLowerCase()).toContain('achieved today');
  });

  it("calls a weekly period 'Achieved This Week' after a rest day", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-13T12:00:00Z')); // Friday
    try {
      const weekly: Habit = {
        ...habit,
        streak: 0,
        goals: [
          { ...habit.goals[0]!, target: 1, frequency_unit: 'per_week' },
          { ...habit.goals[1]!, target: 2, frequency_unit: 'per_week' },
          { ...habit.goals[2]!, target: 3, frequency_unit: 'per_week' },
        ],
        completions: [
          {
            id: 'mon',
            timestamp: new Date('2000-01-01T00:00:00Z'),
            local_day: '2026-03-09',
            completed_units: 3,
          },
        ],
      };
      const component = renderer.create(
        <HabitTile habit={weekly} onOpenGoals={() => {}} tz="UTC" />,
      );
      const text = findChipText(component).toLowerCase();
      expect(text).toContain('achieved this week');
      expect(text).not.toContain('achieved today');
    } finally {
      jest.useRealTimers();
    }
  });

  it("calls a completed monthly period 'Achieved This Month'", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-20T12:00:00Z'));
    try {
      const monthly: Habit = {
        ...habit,
        goals: [
          { ...habit.goals[0]!, target: 1, frequency_unit: 'per_month' },
          { ...habit.goals[1]!, target: 2, frequency_unit: 'per_month' },
          { ...habit.goals[2]!, target: 3, frequency_unit: 'per_month' },
        ],
        completions: [
          {
            id: 'month-start',
            timestamp: new Date('2000-01-01T00:00:00Z'),
            local_day: '2026-03-01',
            completed_units: 3,
          },
        ],
      };
      const component = renderer.create(
        <HabitTile habit={monthly} onOpenGoals={() => {}} tz="UTC" />,
      );
      expect(findChipText(component).toLowerCase()).toContain('achieved this month');
    } finally {
      jest.useRealTimers();
    }
  });
});
