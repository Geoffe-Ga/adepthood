/* eslint-env jest */
/* eslint-disable import/order */
import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import renderer from 'react-test-renderer';

import { HabitTile } from '../HabitTile';
import type { Habit } from '../Habits.types';

describe('HabitTile interactions', () => {
  it('dims tiles with future start dates and responds to icon press', () => {
    const habit: Habit = {
      id: 1,
      stage: 'Beige',
      name: 'Future',
      icon: '⭐',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(Date.now() + 86400000),
      goals: [
        {
          title: 'Low',
          tier: 'low',
          target: 1,
          target_unit: 'u',
          frequency: 1,
          frequency_unit: 'per_day',
          is_additive: true,
        },
        {
          title: 'Clear',
          tier: 'clear',
          target: 2,
          target_unit: 'u',
          frequency: 1,
          frequency_unit: 'per_day',
          is_additive: true,
        },
        {
          title: 'Stretch',
          tier: 'stretch',
          target: 3,
          target_unit: 'u',
          frequency: 1,
          frequency_unit: 'per_day',
          is_additive: true,
        },
      ],
      completions: [],
    };

    const onIconPress = jest.fn();

    const component = renderer.create(
      <HabitTile
        habit={habit}
        onOpenGoals={() => {}}
        onLongPress={() => {}}
        onIconPress={onIconPress}
      />,
    );

    const tile = component.root.findByProps({ testID: 'habit-tile' });
    expect(tile.props.style.opacity).toBe(0.5);

    const icon = component.root.findByProps({ testID: 'habit-icon' });
    renderer.act(() => {
      icon.props.onPress();
    });
    expect(onIconPress).toHaveBeenCalled();
  });
});
