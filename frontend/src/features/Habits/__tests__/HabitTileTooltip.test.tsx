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

// All three tier markers (LG / CG / SG) are visible on the bar at all times
// whenever the corresponding goal exists.  Refactor of the previous logic
// that gated the stretch marker behind ``hasCleared`` -- SG only appeared
// once CG was met, which user-tested as confusing and inconsistent with the
// GoalModal's always-visible stretch marker.
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
