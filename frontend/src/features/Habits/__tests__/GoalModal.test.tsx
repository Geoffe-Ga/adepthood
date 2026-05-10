/* eslint-env jest */
/* global describe, it, expect */
import { jest } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

import { GoalModal } from '../components/GoalModal';
import type { Habit, Goal } from '../Habits.types';
import { logHabitUnits } from '../HabitUtils';

jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: 'UTC' }),
}));

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
  // Click-to-edit chip → input → commit → chip round-trip; tests cover both modes.
  it('renders a saved-state display for every goal tier by default', () => {
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

    expect(testRenderer.root.findByProps({ testID: 'goal-target-display-low' })).toBeTruthy();
    expect(testRenderer.root.findByProps({ testID: 'goal-target-display-clear' })).toBeTruthy();
    expect(testRenderer.root.findByProps({ testID: 'goal-target-display-stretch' })).toBeTruthy();
    expect(() => testRenderer.root.findByProps({ testID: 'goal-target-input-clear' })).toThrow();
  });

  it('switches the tapped row to an input', () => {
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

    const display = testRenderer.root.findByProps({ testID: 'goal-target-display-clear' });
    renderer.act(() => {
      display.props.onPress();
    });

    expect(testRenderer.root.findByProps({ testID: 'goal-target-input-clear' })).toBeTruthy();
  });

  it('commits on onEndEditing and returns the row to display mode', () => {
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

    renderer.act(() => {
      testRenderer.root.findByProps({ testID: 'goal-target-display-clear' }).props.onPress();
    });
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
    expect(onUpdateGoal).toHaveBeenCalledTimes(1);
    // Row collapses back to the saved-state chip on commit.
    expect(testRenderer.root.findByProps({ testID: 'goal-target-display-clear' })).toBeTruthy();
    expect(() => testRenderer.root.findByProps({ testID: 'goal-target-input-clear' })).toThrow();
  });

  it('does not duplicate onUpdateGoal when both onEndEditing and onBlur could fire', () => {
    // React Native fires ``onEndEditing`` + ``onBlur`` back-to-back for a
    // single keyboard-dismissal action (the Done key, then the resulting
    // blur). Wiring the same handler to both — as the first cut of this
    // editor did — sent the optimistic write to the network twice per
    // edit on device. The fix is to wire only ``onEndEditing``; this test
    // pins the exposed prop surface so a regression that re-adds
    // ``onBlur={handleEnd}`` (or any other commit-on-blur handler) fails
    // the suite even when react-test-renderer's quirks around controlled
    // ``useState`` updates would mask it via the behavioural path.
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

    renderer.act(() => {
      testRenderer.root.findByProps({ testID: 'goal-target-display-clear' }).props.onPress();
    });
    const input = testRenderer.root.findByProps({ testID: 'goal-target-input-clear' });

    // ``onEndEditing`` is the canonical commit path on RN: per the React
    // Native docs it fires for both the return-key path *and* the blur
    // path, so an additional ``onBlur`` that commits is strictly
    // duplicative. Asserting absence keeps the contract crisp.
    expect(typeof input.props.onEndEditing).toBe('function');
    expect(input.props.onBlur).toBeUndefined();
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

    renderer.act(() => {
      testRenderer.root.findByProps({ testID: 'goal-target-display-low' }).props.onPress();
    });
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

    renderer.act(() => {
      testRenderer.root.findByProps({ testID: 'goal-target-display-clear' }).props.onPress();
    });
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

describe('GoalModal backdrop close', () => {
  it('exposes a dedicated backdrop element that closes when pressed', () => {
    const onClose = jest.fn();
    const testRenderer = renderer.create(
      <GoalModal
        visible
        habit={sampleHabit}
        onClose={onClose}
        onUpdateGoal={() => {}}
        onLogUnit={() => {}}
        onUpdateHabit={() => {}}
      />,
    );

    const backdrop = testRenderer.root.findByProps({ testID: 'goal-modal-backdrop' });
    renderer.act(() => {
      backdrop.props.onPress();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not wrap the body in a tap-handler that fires onClose', () => {
    const onClose = jest.fn();
    const testRenderer = renderer.create(
      <GoalModal
        visible
        habit={sampleHabit}
        onClose={onClose}
        onUpdateGoal={() => {}}
        onLogUnit={() => {}}
        onUpdateHabit={() => {}}
      />,
    );

    // Walking up the tree from a body element must not hit ``onPress === onClose``.
    const display = testRenderer.root.findByProps({ testID: 'goal-target-display-low' });
    let node: typeof display | null = display.parent;
    while (node) {
      const press = (node.props as { onPress?: unknown }).onPress;
      if (typeof press === 'function' && press === onClose) {
        throw new Error('body has an ancestor whose onPress is onClose');
      }
      node = node.parent;
    }

    expect(onClose).not.toHaveBeenCalled();
  });
});
