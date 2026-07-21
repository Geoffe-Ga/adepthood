import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { Goal, Habit } from '../Habits.types';
import { HabitTile } from '../HabitTile';
import { FULL_SWEEP_MS } from '../starFill';

const HABIT_ID = 42;
const STAGE_COLOR = '#4a3f35';

const MARKER_LOW = 'marker-low';
const MARKER_CLEAR = 'marker-clear';
const MARKER_STRETCH = 'marker-stretch';
const PROGRESS_FILL = 'progress-fill';
const TOOLTIP_CLEAR = 'tooltip-clear';
const TOOLTIP_STRETCH = 'tooltip-stretch';

const makeGoal = (tier: 'low' | 'clear' | 'stretch', overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  title: `${tier} goal`,
  tier,
  target: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  target_unit: 'units',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: HABIT_ID,
  stage: 'Beige',
  name: 'Meditation',
  icon: 'candle',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [makeGoal('low'), makeGoal('clear'), makeGoal('stretch')],
  completions: [],
  revealed: true,
  ...overrides,
});

type TileProps = React.ComponentProps<typeof HabitTile>;
type TilePropsWithLogUnit = TileProps & { onLogUnit: jest.Mock };

const baseProps = (habit: Habit): TileProps => ({
  habit,
  stageColor: STAGE_COLOR,
  onOpenGoals: jest.fn(),
  onLongPress: jest.fn(),
  tz: 'UTC',
  globalIndex: 0,
});

const buildProps = (habit: Habit): TilePropsWithLogUnit => ({
  ...baseProps(habit),
  onLogUnit: jest.fn(),
});

const renderTile = (habit: Habit) => {
  const props = buildProps(habit);
  const utils = render(<HabitTile {...props} />);
  return { ...utils, props };
};

const renderTileWithoutLogUnit = (habit: Habit) => {
  const props = baseProps(habit);
  const utils = render(<HabitTile {...props} />);
  return { ...utils, props };
};

const advance = (ms: number): void => {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
};

const fillWidth = (getByTestId: (_id: string) => { props: { style: { width: string } } }): number =>
  parseFloat(getByTestId(PROGRESS_FILL).props.style.width);

describe('HabitTile star long-press fill', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-03T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('arms the stretch star with the shared long-press delay and fills to it, logging the full delta', () => {
    const { getByTestId, props } = renderTile(makeHabit());
    const marker = getByTestId(MARKER_STRETCH);

    expect(marker.props.accessibilityHint).toBe('Hold to log your Stretch Goal for today.');
    expect(marker.props.accessibilityRole).toBe('button');
    expect(marker.props.accessibilityLabel).toBe('Stretch Goal');

    fireEvent(marker, 'longPress');
    advance(FULL_SWEEP_MS + 100);

    expect(props.onLogUnit).toHaveBeenCalledTimes(1);
    expect(props.onLogUnit).toHaveBeenCalledWith(HABIT_ID, 3);
  });

  it('fills to the clear star and logs the clear delta', () => {
    const { getByTestId, props } = renderTile(makeHabit());

    fireEvent(getByTestId(MARKER_CLEAR), 'longPress');
    advance(FULL_SWEEP_MS + 100);

    expect(props.onLogUnit).toHaveBeenCalledWith(HABIT_ID, 2);
  });

  it('fills to the low star and logs the low delta', () => {
    const { getByTestId, props } = renderTile(makeHabit());

    fireEvent(getByTestId(MARKER_LOW), 'longPress');
    advance(FULL_SWEEP_MS + 100);

    expect(props.onLogUnit).toHaveBeenCalledWith(HABIT_ID, 1);
  });

  it('logs only the remaining units when the bar starts mid-way', () => {
    const habit = makeHabit({
      completions: [{ id: 't-1', timestamp: new Date(), completed_units: 1 }],
    });
    const { getByTestId, props } = renderTile(habit);

    fireEvent(getByTestId(MARKER_STRETCH), 'longPress');
    advance(FULL_SWEEP_MS + 100);

    expect(props.onLogUnit).toHaveBeenCalledWith(HABIT_ID, 2);
  });

  it('reverts to the starting position without logging when released early', () => {
    const { getByTestId, props } = renderTile(makeHabit());
    const marker = getByTestId(MARKER_STRETCH);

    fireEvent(marker, 'longPress');
    advance(FULL_SWEEP_MS / 3);
    fireEvent(marker, 'pressOut');
    advance(FULL_SWEEP_MS * 2);

    expect(props.onLogUnit).not.toHaveBeenCalled();
    expect(fillWidth(getByTestId as never)).toBe(0);
  });

  it('does nothing when today already sits exactly on the pressed star', () => {
    const habit = makeHabit({
      completions: [{ id: 't-1', timestamp: new Date(), completed_units: 3 }],
    });
    const { getByTestId, props } = renderTile(habit);

    fireEvent(getByTestId(MARKER_STRETCH), 'longPress');
    advance(FULL_SWEEP_MS * 2);

    expect(props.onLogUnit).not.toHaveBeenCalled();
    expect(fillWidth(getByTestId as never)).toBe(100);
  });

  it('shows the tooltip on a quick tap without arming a fill', () => {
    const { getByTestId, queryByTestId, props } = renderTile(makeHabit());
    const marker = getByTestId(MARKER_CLEAR);

    fireEvent(marker, 'pressIn');
    expect(getByTestId(TOOLTIP_CLEAR)).toBeTruthy();
    fireEvent(marker, 'pressOut');
    expect(queryByTestId(TOOLTIP_CLEAR)).toBeNull();

    advance(FULL_SWEEP_MS * 2);
    expect(props.onLogUnit).not.toHaveBeenCalled();
  });

  it('dismisses the tooltip when the long-press fill commits, without a pressOut event', () => {
    const { getByTestId, queryByTestId, props } = renderTile(makeHabit());
    const marker = getByTestId(MARKER_STRETCH);

    // A long-press starts with a press-in that reveals the tier tooltip.
    fireEvent(marker, 'pressIn');
    expect(getByTestId(TOOLTIP_STRETCH)).toBeTruthy();

    // The fill arms and sweeps to a committed log. The press-end event is never
    // delivered (the browser bug this guards): the commit alone must clear it.
    fireEvent(marker, 'longPress');
    advance(FULL_SWEEP_MS + 100);

    expect(props.onLogUnit).toHaveBeenCalledWith(HABIT_ID, 3);
    expect(queryByTestId(TOOLTIP_STRETCH)).toBeNull();
  });

  it('does not open the tile settings menu or the goal modal from a star long-press', () => {
    const { getByTestId, props } = renderTile(makeHabit());

    fireEvent(getByTestId(MARKER_STRETCH), 'longPress');
    advance(FULL_SWEEP_MS + 100);

    expect(props.onLongPress).not.toHaveBeenCalled();
    expect(props.onOpenGoals).not.toHaveBeenCalled();
  });

  it('stays tooltip-only with no throw when onLogUnit is not provided', () => {
    const { getByTestId, queryByTestId } = renderTileWithoutLogUnit(makeHabit());
    const marker = getByTestId(MARKER_STRETCH);

    expect(() => {
      fireEvent(marker, 'longPress');
      advance(FULL_SWEEP_MS + 100);
    }).not.toThrow();

    fireEvent(marker, 'pressIn');
    expect(getByTestId(TOOLTIP_STRETCH)).toBeTruthy();
    fireEvent(marker, 'pressOut');
    expect(queryByTestId(TOOLTIP_STRETCH)).toBeNull();
  });
});
