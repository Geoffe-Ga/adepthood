/* eslint-env jest */
/* global describe, it, expect */
/* eslint-disable import/order */
import { jest } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

import { GoalModal } from '../components/GoalModal';
import type { Habit, Goal } from '../Habits.types';
import { logHabitUnits } from '../HabitUtils';

jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

const sampleGoals: Goal[] = [
  {
    id: 1,
    tier: 'low',
    title: 'low',
    target: 1,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
  {
    id: 2,
    tier: 'clear',
    title: 'clear',
    target: 2,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
  {
    id: 3,
    tier: 'stretch',
    title: 'stretch',
    target: 3,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
];

const sampleHabit: Habit = {
  id: 1,
  stage: 'Beige',
  name: 'Test',
  icon: '🔥',
  streak: 0,
  energy_cost: 0,
  energy_return: 0,
  start_date: new Date(),
  goals: sampleGoals,
  completions: [],
};

describe('GoalModal hook order', () => {
  it('renders without crashing when habit becomes available', () => {
    const testRenderer = renderer.create(
      <GoalModal
        visible
        habit={null}
        onClose={() => {}}
        onUpdateGoal={() => {}}
        onLogUnit={() => {}}
        onUpdateHabit={() => {}}
      />,
    );

    expect(() => {
      renderer.act(() => {
        testRenderer.update(
          <GoalModal
            visible
            habit={sampleHabit}
            onClose={() => {}}
            onUpdateGoal={() => {}}
            onLogUnit={() => {}}
            onUpdateHabit={() => {}}
          />,
        );
      });
    }).not.toThrow();
  });
});

describe('GoalModal progress', () => {
  it('shows stretch marker and updates progress fill when habit changes', () => {
    const testRenderer = renderer.create(
      <GoalModal
        visible
        habit={sampleHabit}
        onClose={() => {}}
        onUpdateGoal={() => {}}
        onLogUnit={() => {}}
        onUpdateHabit={() => {}}
      />,
    );

    expect(testRenderer.root.findByProps({ testID: 'modal-marker-stretch' })).toBeTruthy();
    const initialFill = testRenderer.root.findByProps({ testID: 'modal-progress-fill' });
    expect(initialFill.props.style.width).toBe('0%');

    const updatedHabit = logHabitUnits(sampleHabit, 1);
    renderer.act(() => {
      testRenderer.update(
        <GoalModal
          visible
          habit={updatedHabit}
          onClose={() => {}}
          onUpdateGoal={() => {}}
          onLogUnit={() => {}}
          onUpdateHabit={() => {}}
        />,
      );
    });

    const updatedFill = testRenderer.root.findByProps({ testID: 'modal-progress-fill' });
    expect(parseFloat(updatedFill.props.style.width)).toBeCloseTo(33.33, 1);
  });
});
