/* eslint-env jest */
/* global describe, it, expect */
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

describe('GoalModal tooltips', () => {
  it('shows tooltip when hovering over markers', () => {
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

    const lowMarker = testRenderer.root.findByProps({ testID: 'modal-marker-low' });
    renderer.act(() => {
      lowMarker.props.onMouseEnter();
    });
    expect(testRenderer.root.findByProps({ testID: 'modal-tooltip-low' })).toBeTruthy();
    renderer.act(() => {
      lowMarker.props.onMouseLeave();
    });
    expect(() => testRenderer.root.findByProps({ testID: 'modal-tooltip-low' })).toThrow();
  });
});

describe('GoalModal target editor', () => {
  // Mobile users had no way to change goal targets — the only mechanism was
  // dragging tiny 12px markers on the progress bar, which is undiscoverable
  // on touch and doesn't fire reliably for thumb-sized hits. The editor
  // surfaces a TextInput per tier so target adjustments work on phone.
  it('renders an editable target input for every goal tier', () => {
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

    expect(testRenderer.root.findByProps({ testID: 'goal-target-input-low' })).toBeTruthy();
    expect(testRenderer.root.findByProps({ testID: 'goal-target-input-clear' })).toBeTruthy();
    expect(testRenderer.root.findByProps({ testID: 'goal-target-input-stretch' })).toBeTruthy();
  });

  it('calls onUpdateGoal with the new target when the input is committed', () => {
    const onUpdateGoal = jest.fn();
    const testRenderer = renderer.create(
      <GoalModal
        visible
        habit={sampleHabit}
        onClose={() => {}}
        onUpdateGoal={onUpdateGoal}
        onLogUnit={() => {}}
        onUpdateHabit={() => {}}
      />,
    );

    const input = testRenderer.root.findByProps({ testID: 'goal-target-input-clear' });
    renderer.act(() => {
      input.props.onChangeText('5');
    });
    renderer.act(() => {
      input.props.onEndEditing();
    });

    expect(onUpdateGoal).toHaveBeenCalledWith(
      sampleHabit.id,
      expect.objectContaining({ id: 2, tier: 'clear', target: 5 }),
    );
  });

  it('does not call onUpdateGoal when the value did not change', () => {
    const onUpdateGoal = jest.fn();
    const testRenderer = renderer.create(
      <GoalModal
        visible
        habit={sampleHabit}
        onClose={() => {}}
        onUpdateGoal={onUpdateGoal}
        onLogUnit={() => {}}
        onUpdateHabit={() => {}}
      />,
    );

    const input = testRenderer.root.findByProps({ testID: 'goal-target-input-low' });
    renderer.act(() => {
      input.props.onEndEditing();
    });

    expect(onUpdateGoal).not.toHaveBeenCalled();
  });

  it('ignores non-numeric input rather than corrupting the goal target', () => {
    const onUpdateGoal = jest.fn();
    const testRenderer = renderer.create(
      <GoalModal
        visible
        habit={sampleHabit}
        onClose={() => {}}
        onUpdateGoal={onUpdateGoal}
        onLogUnit={() => {}}
        onUpdateHabit={() => {}}
      />,
    );

    const input = testRenderer.root.findByProps({ testID: 'goal-target-input-clear' });
    renderer.act(() => {
      input.props.onChangeText('abc');
    });
    renderer.act(() => {
      input.props.onEndEditing();
    });

    expect(onUpdateGoal).not.toHaveBeenCalled();
  });
});
