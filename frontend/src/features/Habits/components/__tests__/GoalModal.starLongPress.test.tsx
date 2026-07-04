import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('../../../../api', () => ({
  __esModule: true,
  goalGroups: {
    get: jest.fn(() => Promise.resolve(null)),
  },
}));

jest.mock('../../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: 'UTC' }),
}));

import type { Goal, Habit } from '../../Habits.types';
import { FULL_SWEEP_MS, STAR_LONG_PRESS_MS } from '../../starFill';
import { GoalModal } from '../GoalModal';

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
  id: 42,
  stage: 'Beige',
  name: 'Meditation',
  icon: '🧘',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [makeGoal('low'), makeGoal('clear'), makeGoal('stretch')],
  completions: [],
  revealed: true,
  ...overrides,
});

const subtractiveHabit = (overrides: Partial<Habit> = {}): Habit =>
  makeHabit({
    goals: [
      makeGoal('low', { target: 25, is_additive: false }),
      makeGoal('clear', { target: 6, is_additive: false }),
      makeGoal('stretch', { target: 0, is_additive: false }),
    ],
    ...overrides,
  });

const buildProps = (
  habit: Habit,
): React.ComponentProps<typeof GoalModal> & { onLogUnit: jest.Mock } => ({
  visible: true,
  habit,
  onClose: jest.fn(),
  onUpdateGoal: jest.fn(),
  onUpdateGoalUnits: jest.fn(),
  onLogUnit: jest.fn(),
  onUpdateHabit: jest.fn(),
});

const renderModal = (habit: Habit) => {
  const props = buildProps(habit);
  const utils = render(<GoalModal {...props} />);
  return { ...utils, props };
};

const advance = (ms: number): void => {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
};

const fillWidth = (getByTestId: (_id: string) => { props: { style: { width: string } } }): number =>
  parseFloat(getByTestId('modal-progress-fill').props.style.width);

/**
 * Minimal single-touch history accepted by PanResponder's centroid math, so
 * tests can drive the pan-wrapped low/clear markers through the responder
 * protocol (grant → release) without a real gesture system.
 */
const touchHistory = (pageX: number, timeStamp: number) => ({
  numberActiveTouches: 1,
  indexOfSingleActiveTouch: 0,
  mostRecentTimeStamp: timeStamp,
  touchBank: [
    {
      touchActive: true,
      startPageX: pageX,
      startPageY: 0,
      startTimeStamp: timeStamp,
      currentPageX: pageX,
      currentPageY: 0,
      currentTimeStamp: timeStamp,
      previousPageX: pageX,
      previousPageY: 0,
      previousTimeStamp: timeStamp,
    },
  ],
});

const grantMarker = (marker: unknown): void => {
  fireEvent(marker as never, 'responderGrant', {
    touchHistory: touchHistory(0, 1),
    nativeEvent: {},
  });
};

const releaseMarker = (marker: unknown): void => {
  fireEvent(marker as never, 'responderRelease', {
    touchHistory: touchHistory(0, 2),
    nativeEvent: {},
  });
};

describe('GoalModal star long-press fill', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-03T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fills to the stretch star and logs the full delta from an empty bar', () => {
    const { getByTestId, props } = renderModal(makeHabit());

    fireEvent(getByTestId('modal-marker-stretch'), 'longPress');
    advance(FULL_SWEEP_MS + 100);

    expect(props.onLogUnit).toHaveBeenCalledTimes(1);
    expect(props.onLogUnit).toHaveBeenCalledWith(42, 3);
    expect(fillWidth(getByTestId as never)).toBe(100);
  });

  it('logs only the remaining units when the bar starts mid-way', () => {
    const habit = makeHabit({
      completions: [{ id: 't-1', timestamp: new Date(), completed_units: 1 }],
    });
    const { getByTestId, props } = renderModal(habit);

    fireEvent(getByTestId('modal-marker-stretch'), 'longPress');
    advance(FULL_SWEEP_MS + 100);

    expect(props.onLogUnit).toHaveBeenCalledWith(42, 2);
  });

  it('animates the width progressively while the star is held', () => {
    const { getByTestId, props } = renderModal(makeHabit());

    fireEvent(getByTestId('modal-marker-stretch'), 'longPress');
    advance(FULL_SWEEP_MS / 2);

    const midway = fillWidth(getByTestId as never);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(100);
    expect(props.onLogUnit).not.toHaveBeenCalled();
  });

  it('reverts to the starting position without logging when released early', () => {
    const { getByTestId, props } = renderModal(makeHabit());

    const marker = getByTestId('modal-marker-stretch');
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
    const { getByTestId, props } = renderModal(habit);

    fireEvent(getByTestId('modal-marker-stretch'), 'longPress');
    advance(FULL_SWEEP_MS * 2);

    expect(props.onLogUnit).not.toHaveBeenCalled();
    expect(fillWidth(getByTestId as never)).toBe(100);
  });

  it('drains a subtractive habit bar to the pressed limit star and logs the consumed units', () => {
    const { getByTestId, props } = renderModal(subtractiveHabit());
    const lowMarker = getByTestId('modal-marker-low');

    grantMarker(lowMarker);
    advance(STAR_LONG_PRESS_MS);
    advance(FULL_SWEEP_MS / 2);
    const midway = fillWidth(getByTestId as never);
    expect(midway).toBeLessThan(100);
    expect(midway).toBeGreaterThan(0);

    advance(FULL_SWEEP_MS / 2 + 100);
    expect(props.onLogUnit).toHaveBeenCalledTimes(1);
    expect(props.onLogUnit).toHaveBeenCalledWith(42, 25);
    expect(fillWidth(getByTestId as never)).toBe(0);
  });

  it('refills a subtractive bar toward the stretch star by logging a negative correction', () => {
    const habit = subtractiveHabit({
      completions: [{ id: 't-1', timestamp: new Date(), completed_units: 10 }],
    });
    const { getByTestId, props } = renderModal(habit);

    fireEvent(getByTestId('modal-marker-stretch'), 'longPress');
    advance(FULL_SWEEP_MS + 100);

    expect(props.onLogUnit).toHaveBeenCalledWith(42, -10);
    expect(fillWidth(getByTestId as never)).toBe(100);
  });

  it('moves an additive bar leftward with a negative log when past the pressed star', () => {
    const habit = makeHabit({
      completions: [{ id: 't-1', timestamp: new Date(), completed_units: 2 }],
    });
    const { getByTestId, props } = renderModal(habit);
    const lowMarker = getByTestId('modal-marker-low');

    grantMarker(lowMarker);
    advance(STAR_LONG_PRESS_MS + FULL_SWEEP_MS);

    expect(props.onLogUnit).toHaveBeenCalledWith(42, -1);
  });

  it('does not open the drag-edit confirm after a long-press fill completes', () => {
    const { getByTestId, queryByTestId, props } = renderModal(subtractiveHabit());
    const lowMarker = getByTestId('modal-marker-low');

    grantMarker(lowMarker);
    advance(STAR_LONG_PRESS_MS + FULL_SWEEP_MS + 100);
    releaseMarker(lowMarker);

    expect(props.onLogUnit).toHaveBeenCalledTimes(1);
    expect(queryByTestId('goal-edit-confirm')).toBeNull();
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
  });

  it('reverts a pan-marker fill without logging when released before the star', () => {
    const { getByTestId, queryByTestId, props } = renderModal(subtractiveHabit());
    const lowMarker = getByTestId('modal-marker-low');

    grantMarker(lowMarker);
    advance(STAR_LONG_PRESS_MS + FULL_SWEEP_MS / 3);
    releaseMarker(lowMarker);
    advance(FULL_SWEEP_MS * 2);

    expect(props.onLogUnit).not.toHaveBeenCalled();
    expect(queryByTestId('goal-edit-confirm')).toBeNull();
    expect(fillWidth(getByTestId as never)).toBe(100);
  });

  it('still opens the drag-edit confirm on a quick tap of a draggable star', () => {
    const { getByTestId, props } = renderModal(makeHabit());
    const lowMarker = getByTestId('modal-marker-low');

    grantMarker(lowMarker);
    advance(STAR_LONG_PRESS_MS / 4);
    releaseMarker(lowMarker);

    expect(getByTestId('goal-edit-confirm')).toBeTruthy();
    advance(FULL_SWEEP_MS * 2);
    expect(props.onLogUnit).not.toHaveBeenCalled();
  });
});
