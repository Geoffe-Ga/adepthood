import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

// EmojiSelector pulls in native bindings; render a stub.
jest.mock('react-native-emoji-selector', () => () => null);

jest.mock('../../../../api', () => ({
  __esModule: true,
  goalGroups: {
    get: jest.fn(() => Promise.resolve(null)),
  },
}));

jest.mock('../../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: 'UTC' }),
}));

// Use real RN primitives — no global ``react-native`` mock — so
// fireEvent.changeText / press behave as on a real device.

import { dayKeyInTZ } from '../../../../utils/dateUtils';
import type { Goal, Habit } from '../../Habits.types';
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

const renderModal = (
  habit: Habit | null = makeHabit(),
  overrides: Partial<React.ComponentProps<typeof GoalModal>> = {},
) => {
  const props = {
    visible: true,
    habit,
    onClose: jest.fn(),
    onUpdateGoal: jest.fn(),
    onUpdateGoalUnits: jest.fn(),
    onLogUnit: jest.fn(),
    onUpdateHabit: jest.fn(),
    ...overrides,
  };
  const utils = render(<GoalModal {...props} />);
  const toggle = utils.queryByTestId('goal-modal-edit-toggle');
  if (toggle) fireEvent.press(toggle);
  return { ...utils, props };
};

describe('GoalModal goal-target editor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the inline goal-target editor when the habit has goals and an id', () => {
    const { getByTestId } = renderModal();
    expect(getByTestId('goal-target-editor')).toBeTruthy();
    expect(getByTestId('goal-unit-editor')).toBeTruthy();
  });

  it('shows the saved target value as a tappable chip by default', () => {
    const { getByTestId, queryByTestId } = renderModal();
    expect(getByTestId('goal-target-display-low')).toBeTruthy();
    expect(queryByTestId('goal-target-input-low')).toBeNull();
  });

  it('switches the row to a recessed input plus Save button when the chip is tapped', () => {
    const { getByTestId } = renderModal();
    fireEvent.press(getByTestId('goal-target-display-low'));
    expect(getByTestId('goal-target-input-low')).toBeTruthy();
    // Save is the explicit affordance the chip-on-blur design lacked --
    // its presence is what tells the user their typed change is savable.
    expect(getByTestId('goal-target-save-low')).toBeTruthy();
  });

  it('commits the per-tier numeric target when the Save button is pressed', () => {
    const { getByTestId, queryByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-target-display-low'));
    const input = getByTestId('goal-target-input-low');
    fireEvent.changeText(input, '7');
    fireEvent.press(getByTestId('goal-target-save-low'));
    expect(props.onUpdateGoal).toHaveBeenCalledTimes(1);
    expect(props.onUpdateGoal).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ tier: 'low', target: 7 }),
    );
    expect(getByTestId('goal-target-display-low')).toBeTruthy();
    expect(queryByTestId('goal-target-input-low')).toBeNull();
    expect(queryByTestId('goal-target-save-low')).toBeNull();
  });

  it('still commits on blur (endEditing) so keyboard-dismiss saves what the user typed', () => {
    const { getByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-target-display-low'));
    const input = getByTestId('goal-target-input-low');
    fireEvent.changeText(input, '7');
    fireEvent(input, 'endEditing');
    expect(props.onUpdateGoal).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ tier: 'low', target: 7 }),
    );
  });

  it('collapses the Save-then-blur double event into a single onUpdateGoal call', () => {
    // Tapping Save fires onPress, then the TextInput blurs and fires
    // onEndEditing. Without the submittedRef guard we would PUT twice.
    const { getByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-target-display-low'));
    const input = getByTestId('goal-target-input-low');
    fireEvent.changeText(input, '9');
    fireEvent.press(getByTestId('goal-target-save-low'));
    fireEvent(input, 'endEditing');
    expect(props.onUpdateGoal).toHaveBeenCalledTimes(1);
  });

  it('collapses the Return-key-then-blur sequence into a single onUpdateGoal call', () => {
    // Symmetric to the Save-then-blur test: pressing Return fires
    // onSubmitEditing AND onEndEditing on most platforms; the submittedRef
    // guard must dedupe that pair the same way it dedupes Save+blur.
    const { getByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-target-display-low'));
    const input = getByTestId('goal-target-input-low');
    fireEvent.changeText(input, '9');
    fireEvent(input, 'submitEditing');
    fireEvent(input, 'endEditing');
    expect(props.onUpdateGoal).toHaveBeenCalledTimes(1);
  });

  it('reverts the draft and skips the commit when the input is non-numeric', () => {
    const { getByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-target-display-low'));
    const input = getByTestId('goal-target-input-low');
    fireEvent.changeText(input, 'abc');
    fireEvent.press(getByTestId('goal-target-save-low'));
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
  });

  it('skips the commit when the input matches the current value', () => {
    const { getByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-target-display-low'));
    const input = getByTestId('goal-target-input-low');
    fireEvent.changeText(input, '1'); // already 1
    fireEvent.press(getByTestId('goal-target-save-low'));
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
  });
});

describe('GoalModal unit + frequency editor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('commits a target_unit change as ONE atomic batch call (#289)', () => {
    // Invariant: a unit edit moves every tier together. The old per-tier
    // ``onUpdateGoal`` fan-out left tiers on mismatched units server-side
    // when a mid-sequence PUT failed; the batch endpoint updates all the
    // habit's goals inside a single transaction.
    const { getByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-target-unit-minutes'));

    expect(props.onUpdateGoalUnits).toHaveBeenCalledTimes(1);
    expect(props.onUpdateGoalUnits).toHaveBeenCalledWith(42, { target_unit: 'minutes' });
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
  });

  it('commits a frequency_unit change as ONE atomic batch call (#289)', () => {
    const { getByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-frequency-unit-per_week'));

    expect(props.onUpdateGoalUnits).toHaveBeenCalledTimes(1);
    expect(props.onUpdateGoalUnits).toHaveBeenCalledWith(42, { frequency_unit: 'per_week' });
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
  });

  it('commits a numeric frequency change on blur as ONE atomic batch call (#289)', () => {
    const { getByTestId, props } = renderModal();
    const input = getByTestId('goal-frequency-input');
    fireEvent.changeText(input, '3');
    fireEvent(input, 'endEditing');

    expect(props.onUpdateGoalUnits).toHaveBeenCalledTimes(1);
    expect(props.onUpdateGoalUnits).toHaveBeenCalledWith(42, { frequency: 3 });
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
  });

  it('drops a non-finite frequency without firing any update', () => {
    const { getByTestId, props } = renderModal();
    const input = getByTestId('goal-frequency-input');
    fireEvent.changeText(input, 'abc');
    fireEvent(input, 'endEditing');
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
    expect(props.onUpdateGoalUnits).not.toHaveBeenCalled();
  });

  it('drops a zero or negative frequency (positivity invariant)', () => {
    const { getByTestId, props } = renderModal();
    const input = getByTestId('goal-frequency-input');
    fireEvent.changeText(input, '0');
    fireEvent(input, 'endEditing');
    fireEvent.changeText(input, '-2');
    fireEvent(input, 'endEditing');
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
  });

  it('skips the commit when the frequency draft equals the current value', () => {
    const { getByTestId, props } = renderModal();
    const input = getByTestId('goal-frequency-input');
    fireEvent.changeText(input, '1'); // already 1
    fireEvent(input, 'endEditing');
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
  });

  it('marks the currently-selected unit chip as checked for screen readers', () => {
    // Chips are mutually-exclusive radios, not generic toggle buttons —
    // the accessibilityState must reflect ``checked`` so VoiceOver/
    // TalkBack announce selection correctly.
    const { getByTestId } = renderModal();
    const selected = getByTestId('goal-target-unit-units');
    const other = getByTestId('goal-target-unit-minutes');
    expect(selected.props.accessibilityRole).toBe('radio');
    expect(selected.props.accessibilityState).toEqual({ checked: true });
    expect(other.props.accessibilityState).toEqual({ checked: false });
  });
});

describe('GoalModal direction toggle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders an Add up / Cut back chip pair reflecting the habit direction', () => {
    const { getByTestId } = renderModal();
    const additive = getByTestId('goal-direction-additive');
    const subtractive = getByTestId('goal-direction-subtractive');
    expect(additive.props.accessibilityRole).toBe('radio');
    expect(additive.props.accessibilityState).toEqual({ checked: true });
    expect(subtractive.props.accessibilityState).toEqual({ checked: false });
  });

  it('marks the subtractive chip checked when the habit is subtractive', () => {
    const subtractiveHabit = makeHabit({
      goals: [
        makeGoal('low', { target: 25, is_additive: false }),
        makeGoal('clear', { target: 6, is_additive: false }),
        makeGoal('stretch', { target: 0, is_additive: false }),
      ],
    });
    const { getByTestId } = renderModal(subtractiveHabit);
    expect(getByTestId('goal-direction-additive').props.accessibilityState).toEqual({
      checked: false,
    });
    expect(getByTestId('goal-direction-subtractive').props.accessibilityState).toEqual({
      checked: true,
    });
  });

  it('flips all three tiers when switching from additive to subtractive and inverts target order', () => {
    // Habit starts additive with low=1, clear=2, stretch=3. Switching to
    // subtractive ("Cut back") should send PUTs for all three tiers with
    // is_additive=false and the targets inverted so ``low`` (the most
    // lenient limit) gets the largest target and ``stretch`` (the strictest
    // cap) gets the smallest. PUTs fan out in ascending-new-target order so
    // each clamp in ``normalizeGoalTiers`` is a no-op.
    const { getByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-direction-subtractive'));

    expect(props.onUpdateGoal).toHaveBeenCalledTimes(3);
    expect(props.onUpdateGoal).toHaveBeenNthCalledWith(
      1,
      42,
      expect.objectContaining({ tier: 'stretch', target: 1, is_additive: false }),
    );
    expect(props.onUpdateGoal).toHaveBeenNthCalledWith(
      2,
      42,
      expect.objectContaining({ tier: 'clear', target: 2, is_additive: false }),
    );
    expect(props.onUpdateGoal).toHaveBeenNthCalledWith(
      3,
      42,
      expect.objectContaining({ tier: 'low', target: 3, is_additive: false }),
    );
  });

  it('flips back to additive and restores ascending target order', () => {
    const subtractiveHabit = makeHabit({
      goals: [
        makeGoal('low', { target: 25, is_additive: false }),
        makeGoal('clear', { target: 6, is_additive: false }),
        makeGoal('stretch', { target: 0, is_additive: false }),
      ],
    });
    const { getByTestId, props } = renderModal(subtractiveHabit);
    fireEvent.press(getByTestId('goal-direction-additive'));

    expect(props.onUpdateGoal).toHaveBeenCalledTimes(3);
    // Smallest new target first so each PUT's clamp is a no-op against the
    // already-additive suffix. For additive, ``low`` takes the smallest.
    expect(props.onUpdateGoal).toHaveBeenNthCalledWith(
      1,
      42,
      expect.objectContaining({ tier: 'low', target: 0, is_additive: true }),
    );
    expect(props.onUpdateGoal).toHaveBeenNthCalledWith(
      2,
      42,
      expect.objectContaining({ tier: 'clear', target: 6, is_additive: true }),
    );
    expect(props.onUpdateGoal).toHaveBeenNthCalledWith(
      3,
      42,
      expect.objectContaining({ tier: 'stretch', target: 25, is_additive: true }),
    );
  });

  it('does nothing when the user taps the chip already selected', () => {
    const { getByTestId, props } = renderModal();
    fireEvent.press(getByTestId('goal-direction-additive'));
    expect(props.onUpdateGoal).not.toHaveBeenCalled();
  });
});

describe('GoalModal editor visibility guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hides the editor when the habit has no id (synthetic onboarding state)', () => {
    const { queryByTestId } = renderModal(makeHabit({ id: undefined as unknown as number }));
    expect(queryByTestId('goal-target-editor')).toBeNull();
  });

  it('hides the editor when the habit has no goals', () => {
    const { queryByTestId } = renderModal(makeHabit({ goals: [] }));
    expect(queryByTestId('goal-target-editor')).toBeNull();
  });
});

describe('GoalModal progress bar daily reset', () => {
  const yesterdayUtc = (): Date => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(12, 0, 0, 0);
    return d;
  };

  const getFillWidth = (
    queryByTestId: (id: string) => { props: { style: { width: string } } } | null,
  ): string => {
    const fill = queryByTestId('modal-progress-fill');
    return fill?.props.style.width ?? '';
  };

  it('renders the progress bar empty when only yesterday hit the stretch goal', () => {
    const stretchedYesterday = makeHabit({
      completions: [{ id: 'y-1', timestamp: yesterdayUtc(), completed_units: 9 }],
    });
    const { queryByTestId } = renderModal(stretchedYesterday);
    expect(getFillWidth(queryByTestId as never)).toBe('0%');
  });

  it("fills the progress bar when today's completions hit the stretch goal", () => {
    const stretchedToday = makeHabit({
      completions: [
        { id: 'y-1', timestamp: yesterdayUtc(), completed_units: 9 },
        { id: 't-1', timestamp: new Date(), completed_units: 3 },
      ],
    });
    const { queryByTestId } = renderModal(stretchedToday);
    expect(getFillWidth(queryByTestId as never)).toBe('100%');
  });
});

describe('GoalModal log-date stepper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults the log date to Today', () => {
    const { getByTestId } = renderModal();
    expect(getByTestId('log-date-label').props.children).toBe('Today');
  });

  it('disables the next arrow while the date is Today so the future cannot be logged', () => {
    const { getByTestId } = renderModal();
    expect(getByTestId('log-date-next').props.accessibilityState).toEqual({ disabled: true });
  });

  it('steps back to Yesterday and re-enables the next arrow', () => {
    const { getByTestId } = renderModal();
    fireEvent.press(getByTestId('log-date-prev'));
    expect(getByTestId('log-date-label').props.children).toBe('Yesterday');
    expect(getByTestId('log-date-next').props.accessibilityState).toEqual({ disabled: false });
  });

  it('shows an explicit calendar date once stepped back beyond yesterday', () => {
    const { getByTestId } = renderModal();
    fireEvent.press(getByTestId('log-date-prev'));
    fireEvent.press(getByTestId('log-date-prev'));
    const label = getByTestId('log-date-label').props.children;
    expect(label).not.toBe('Today');
    expect(label).not.toBe('Yesterday');
  });

  it('returns to Today when the next arrow undoes a step back', () => {
    const { getByTestId } = renderModal();
    fireEvent.press(getByTestId('log-date-prev'));
    fireEvent.press(getByTestId('log-date-next'));
    expect(getByTestId('log-date-label').props.children).toBe('Today');
  });

  it('logs against the stepped-back day, passing the date to onLogUnit', () => {
    const { getByTestId, getByText, props } = renderModal();
    fireEvent.press(getByTestId('log-date-prev'));
    fireEvent.press(getByText('Log Units'));

    const calls = (props.onLogUnit as unknown as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    const [habitId, amount, date] = calls[0] as [number, number, Date];
    expect(habitId).toBe(42);
    expect(amount).toBe(1);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(dayKeyInTZ(date, 'UTC')).toBe(dayKeyInTZ(yesterday, 'UTC'));
  });
});
