import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import WritingHabitGoalEditor from '../WritingHabitGoalEditor';

function setup() {
  const onSave = jest.fn();
  const onCancel = jest.fn();
  return {
    ...render(<WritingHabitGoalEditor onSave={onSave} onCancel={onCancel} />),
    onSave,
    onCancel,
  };
}

describe('writing timer goal setup', () => {
  it('starts with the writer’s 10/20/45-minute daily defaults', () => {
    const screen = setup();
    fireEvent.press(screen.getByTestId('writing-habit-goals-save'));
    expect(screen.onSave).toHaveBeenCalledWith({
      target_unit: 'minutes',
      frequency: 1,
      frequency_unit: 'per_day',
      low: 10,
      clear: 20,
      stretch: 45,
    });
  });
  it('allows sessions and uses the 1/1/1 session defaults', () => {
    const screen = setup();
    fireEvent.press(screen.getByTestId('goal-target-unit-sessions'));
    fireEvent.press(screen.getByTestId('writing-habit-goals-save'));
    expect(screen.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        target_unit: 'sessions',
        low: 1,
        clear: 1,
        stretch: 1,
      }),
    );
  });
  it('offers only timer units, supported cadences, and additive counting', () => {
    const screen = setup();
    expect(screen.queryByTestId('goal-target-unit-pages')).toBeNull();
    expect(screen.queryByTestId('goal-target-unit-hours')).toBeNull();
    expect(screen.queryByTestId('goal-frequency-unit-per_month')).toBeNull();
    expect(screen.queryByTestId('goal-direction-subtractive')).toBeNull();
  });
  it('cancels without writing or linking anything', () => {
    const screen = setup();
    fireEvent.press(screen.getByTestId('writing-habit-goals-cancel'));
    expect(screen.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.onSave).not.toHaveBeenCalled();
  });
});
