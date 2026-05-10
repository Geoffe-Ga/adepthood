/* eslint-env jest */
/* global describe, it, expect */
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
});
