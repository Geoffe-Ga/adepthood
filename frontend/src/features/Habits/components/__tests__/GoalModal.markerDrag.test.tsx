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
import { STAR_LONG_PRESS_MS } from '../../starFill';
import { GoalModal } from '../GoalModal';

/** Bar width fired through `onLayout`, so one bar percent is exactly two pixels. */
const BAR_WIDTH_PX = 200;

const makeGoal = (tier: 'low' | 'clear' | 'stretch', overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  title: `${tier} goal`,
  tier,
  target: tier === 'low' ? 2 : tier === 'clear' ? 6 : 8,
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

/** The repo's own subtractive fixture shape: low 25 / clear 6 / stretch 0. */
const subtractiveHabit = (): Habit =>
  makeHabit({
    goals: [
      makeGoal('low', { target: 25, is_additive: false }),
      makeGoal('clear', { target: 6, is_additive: false }),
      makeGoal('stretch', { target: 0, is_additive: false }),
    ],
  });

/** The repo's own weekly fixture: 1 / 2 / 4 sessions, three times per week. */
const weeklyHabit = (): Habit =>
  makeHabit({
    goals: (['low', 'clear', 'stretch'] as const).map((tier, index) =>
      makeGoal(tier, {
        target: [1, 2, 4][index],
        target_unit: 'sessions',
        frequency: 3,
        frequency_unit: 'per_week',
      }),
    ),
  });

const buildProps = (
  habit: Habit,
): React.ComponentProps<typeof GoalModal> & { onUpdateGoal: jest.Mock } => ({
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

/**
 * Minimal single-touch history accepted by PanResponder's centroid math. The
 * current/previous split is what produces a non-zero `dx`, and each event
 * needs a strictly larger timestamp or `_accountsForMovesUpTo` drops it.
 */
const touchHistory = (currentPageX: number, previousPageX: number, timeStamp: number) => ({
  numberActiveTouches: 1,
  indexOfSingleActiveTouch: 0,
  mostRecentTimeStamp: timeStamp,
  touchBank: [
    {
      touchActive: true,
      startPageX: previousPageX,
      startPageY: 0,
      startTimeStamp: 1,
      currentPageX,
      currentPageY: 0,
      currentTimeStamp: timeStamp,
      previousPageX,
      previousPageY: 0,
      previousTimeStamp: timeStamp - 1,
    },
  ],
});

/** Give the goal bar a real measured width; the drag is inert without one. */
const layoutBar = (getByTestId: (_id: string) => unknown): void => {
  fireEvent(getByTestId('modal-progress-fill') as never, 'layout', {
    nativeEvent: { layout: { width: BAR_WIDTH_PX, height: 12, x: 0, y: 0 } },
  });
};

const grantMarker = (marker: unknown): void => {
  fireEvent(marker as never, 'responderGrant', {
    touchHistory: touchHistory(0, 0, 1),
    nativeEvent: {},
  });
};

const moveMarker = (
  marker: unknown,
  toPageX: number,
  fromPageX: number,
  timeStamp: number,
): void => {
  fireEvent(marker as never, 'responderMove', {
    touchHistory: touchHistory(toPageX, fromPageX, timeStamp),
    nativeEvent: {},
  });
};

const releaseMarker = (marker: unknown, pageX: number, timeStamp: number): void => {
  fireEvent(marker as never, 'responderRelease', {
    touchHistory: touchHistory(pageX, pageX, timeStamp),
    nativeEvent: {},
  });
};

const terminateMarker = (marker: unknown, pageX: number, timeStamp: number): void => {
  fireEvent(marker as never, 'responderTerminate', {
    touchHistory: touchHistory(pageX, pageX, timeStamp),
    nativeEvent: {},
  });
};

/** The goal object the modal handed to `onUpdateGoal` on its most recent call. */
const savedGoal = (onUpdateGoal: jest.Mock): Goal => {
  const call = onUpdateGoal.mock.calls.at(-1) as [number, Goal] | undefined;
  if (!call) throw new Error('onUpdateGoal was never called');
  return call[1];
};

const markerLeft = (getByTestId: (_id: string) => unknown, tier: 'low' | 'clear'): string =>
  (getByTestId(`modal-marker-${tier}`) as { props: { style: { left: string } } }).props.style.left;

describe('GoalModal marker drag', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-03T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('saves the dropped Low Grit target rather than a first-render zero', () => {
    const { getByTestId, props } = renderModal(makeHabit());
    layoutBar(getByTestId);
    const low = getByTestId('modal-marker-low');

    grantMarker(low);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(low, 50, 0, 2); // +50px on a 200px bar = +25% → 25% + 25% = 50%
    releaseMarker(low, 50, 3);
    fireEvent.press(getByTestId('goal-edit-confirm-button'));

    expect(props.onUpdateGoal).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ tier: 'low', target: 4 }),
    );
  });

  it('saves the dropped Clear Goal target rather than a first-render zero', () => {
    const { getByTestId, props } = renderModal(makeHabit());
    layoutBar(getByTestId);
    const clear = getByTestId('modal-marker-clear');

    grantMarker(clear);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(clear, -30, 0, 2); // -30px = -15% → 75% - 15% = 60%
    releaseMarker(clear, -30, 3);
    fireEvent.press(getByTestId('goal-edit-confirm-button'));

    // round(0.60 * 8) = 4.8 → 5; deliberately a different number from the low
    // drop, so no constant or floor can satisfy both specs.
    expect(props.onUpdateGoal).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ tier: 'clear', target: 5 }),
    );
  });

  it('moves the Low Grit star with the finger instead of collapsing it to the bar start', () => {
    const { getByTestId } = renderModal(makeHabit());
    layoutBar(getByTestId);
    const low = getByTestId('modal-marker-low');

    grantMarker(low);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(low, 50, 0, 2);

    expect(markerLeft(getByTestId, 'low')).toBe('50%');
  });

  it('never saves a target above the stretch target on a crowded goal set', () => {
    const crowded = makeHabit({
      goals: [
        makeGoal('low', { target: 98 }),
        makeGoal('clear', { target: 99 }),
        makeGoal('stretch', { target: 100 }),
      ],
    });
    const { getByTestId, props } = renderModal(crowded);
    layoutBar(getByTestId);
    const clear = getByTestId('modal-marker-clear');

    grantMarker(clear);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(clear, 20, 0, 2); // 99% + 10% = 109% raw
    releaseMarker(clear, 20, 3);
    fireEvent.press(getByTestId('goal-edit-confirm-button'));

    expect(props.onUpdateGoal).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ tier: 'clear', target: 100 }),
    );
    expect(savedGoal(props.onUpdateGoal).target).toBeLessThanOrEqual(100);
  });

  it('round-trips a per_week habit in its own raw units', () => {
    const { getByTestId, props } = renderModal(weeklyHabit());
    layoutBar(getByTestId);
    const clear = getByTestId('modal-marker-clear');

    grantMarker(clear);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(clear, 100, 0, 2); // 50% + 50% = the stretch star
    releaseMarker(clear, 100, 3);
    fireEvent.press(getByTestId('goal-edit-confirm-button'));

    // Landing on the stretch star must save the stretch star's RAW target.
    expect(props.onUpdateGoal).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ tier: 'clear', target: 4 }),
    );
  });

  it('inverts a subtractive bar instead of saving one unit for every drop', () => {
    const { getByTestId, props } = renderModal(subtractiveHabit());
    layoutBar(getByTestId);
    const clear = getByTestId('modal-marker-clear');

    grantMarker(clear);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(clear, -50, 0, 2); // 76% - 25% = 51%
    releaseMarker(clear, -50, 3);
    fireEvent.press(getByTestId('goal-edit-confirm-button'));

    // 25 - 0.51 * 25 = 12.25 → 12
    expect(props.onUpdateGoal).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ tier: 'clear', target: 12 }),
    );
  });

  it('refuses a subtractive Low Grit drag and puts the star back without a dialog', () => {
    const { getByTestId, queryByTestId, props } = renderModal(subtractiveHabit());
    layoutBar(getByTestId);
    const low = getByTestId('modal-marker-low');

    grantMarker(low);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(low, 60, 0, 2);
    releaseMarker(low, 60, 3);

    expect(queryByTestId('goal-edit-confirm')).toBeNull();
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
    expect(markerLeft(getByTestId, 'low')).toBe('0%');
  });

  it('is inert while the bar has not laid out, saving no NaN and moving no star', () => {
    const { getByTestId, props } = renderModal(makeHabit());
    const low = getByTestId('modal-marker-low');

    grantMarker(low);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(low, 20, 0, 2); // supra-slop: enters the drag
    moveMarker(low, 0, 20, 3); // back to dx 0: the 0/0 division
    expect(markerLeft(getByTestId, 'low')).toBe('25%');

    releaseMarker(low, 0, 4);
    fireEvent.press(getByTestId('goal-edit-confirm-button'));

    const saved = savedGoal(props.onUpdateGoal);
    expect(Number.isFinite(saved.target)).toBe(true);
    expect(saved.target).toBe(2);
  });

  it('restores the dragged star and saves nothing when the confirmation is cancelled', () => {
    const { getByTestId, props } = renderModal(makeHabit());
    layoutBar(getByTestId);
    const clear = getByTestId('modal-marker-clear');

    grantMarker(clear);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(clear, -30, 0, 2);
    releaseMarker(clear, -30, 3);
    fireEvent.press(getByTestId('goal-edit-cancel'));

    expect(props.onUpdateGoal).not.toHaveBeenCalled();
    expect(markerLeft(getByTestId, 'clear')).toBe('75%');
    expect(markerLeft(getByTestId, 'low')).toBe('25%');
  });

  it('restores the dragged star and opens no dialog when the gesture is stolen', () => {
    const { getByTestId, queryByTestId, props } = renderModal(makeHabit());
    layoutBar(getByTestId);
    const low = getByTestId('modal-marker-low');

    grantMarker(low);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(low, 50, 0, 2);
    terminateMarker(low, 50, 3);

    expect(queryByTestId('goal-edit-confirm')).toBeNull();
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
    expect(markerLeft(getByTestId, 'low')).toBe('25%');
  });

  it('keeps one pan responder per marker for the component lifetime', () => {
    const habit = makeHabit();
    const props = buildProps(habit);
    const { getByTestId, rerender } = render(<GoalModal {...props} />);
    const before = (getByTestId('modal-marker-low') as { props: Record<string, unknown> }).props
      .onResponderGrant;

    rerender(<GoalModal {...props} habit={makeHabit({ name: 'Renamed' })} />);
    const after = (getByTestId('modal-marker-low') as { props: Record<string, unknown> }).props
      .onResponderGrant;

    // An in-flight hold must survive the re-renders the drag itself causes.
    expect(after).toBe(before);
  });

  it('confirms against the habit currently rendered, not the one it mounted with', () => {
    const props = buildProps(makeHabit());
    const { getByTestId, rerender } = render(<GoalModal {...props} />);

    // The goals change under the still-mounted modal: a wider stretch target
    // and a different unit. The responders must see both.
    const edited = makeHabit({
      goals: [
        makeGoal('low', { target_unit: 'pages' }),
        makeGoal('clear', { target_unit: 'pages' }),
        makeGoal('stretch', { target: 16, target_unit: 'pages' }),
      ],
    });
    rerender(<GoalModal {...props} habit={edited} />);
    layoutBar(getByTestId);
    const low = getByTestId('modal-marker-low');

    grantMarker(low);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(low, 20, 0, 2); // 12.5% + 10% = 22.5% of a stretch target of 16
    releaseMarker(low, 20, 3);
    fireEvent.press(getByTestId('goal-edit-confirm-button'));

    expect(props.onUpdateGoal).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ tier: 'low', target: 4, target_unit: 'pages' }),
    );
  });

  it('settles the star on the persisted target once the parent re-renders', () => {
    const habit = makeHabit();
    const props = buildProps(habit);
    const { getByTestId, rerender } = render(<GoalModal {...props} />);
    layoutBar(getByTestId);
    const clear = getByTestId('modal-marker-clear');

    grantMarker(clear);
    advance(STAR_LONG_PRESS_MS / 4);
    moveMarker(clear, -30, 0, 2);
    releaseMarker(clear, -30, 3);
    fireEvent.press(getByTestId('goal-edit-confirm-button'));

    const saved = makeHabit({
      goals: [makeGoal('low'), makeGoal('clear', { target: 5 }), makeGoal('stretch')],
    });
    rerender(<GoalModal {...props} habit={saved} />);
    expect(markerLeft(getByTestId, 'clear')).toBe('62.5%');

    rerender(<GoalModal {...props} habit={saved} visible={false} />);
    rerender(<GoalModal {...props} habit={saved} visible />);
    expect(markerLeft(getByTestId, 'clear')).toBe('62.5%');
  });
});
