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
  completions: [{ id: 1, timestamp: new Date(), completed_units: 5 }],
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
