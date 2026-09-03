import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act, within } from '@testing-library/react-native';
import React from 'react';
import type { ReactElement, ReactNode } from 'react';

import { useProgramStore } from '../../../../store/useProgramStore';
import type { Habit, HabitMergePlan, OnboardingHabit } from '../../Habits.types';

jest.mock('../../constants', () => ({
  ...(jest.requireActual('../../constants') as Record<string, unknown>),
  DEFAULT_ICONS: ['⭐'],
}));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: ReactNode }) => children,
  Gesture: {
    LongPress: () => ({ minDuration: () => ({ onStart: () => ({}) }) }),
    Pan: () => ({ onBegin: () => ({}) }),
    Race: () => ({}),
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  View: require('react-native').View,
}));
jest.mock('react-native-draggable-flatlist', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return ({
    data,
    renderItem,
    testID,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: { id: string }[];
    renderItem: (_info: {
      item: { id: string };
      index: number;
      drag: () => void;
      isActive: boolean;
      getIndex: () => number;
    }) => ReactElement;
    testID?: string;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <View testID={testID} data={data}>
      {ListHeaderComponent}
      {data.map((item, index) =>
        ReactLib.cloneElement(
          renderItem({ item, index, drag: jest.fn(), isActive: false, getIndex: () => index }),
          { key: item.id },
        ),
      )}
      {ListFooterComponent}
    </View>
  );
});
jest.mock('../../../../api', () => ({
  goalGroups: { list: jest.fn(() => Promise.resolve([])) },
}));

const OnboardingModal = require('../OnboardingModal').default;

const MEDITATE = 'Meditate';
const MORNING_PAGES = 'Morning pages';
const COLD_SHOWER = 'Cold shower';
const HABIT_NAME_PLACEHOLDER = 'Enter habit name';
const REVEAL_TOTAL_MS = 150 * 4 + 500 + 100;

const habit = (over: Partial<Habit> = {}): Habit =>
  ({
    id: 7,
    name: MEDITATE,
    icon: '🧘',
    stage: 'Beige',
    streak: 4,
    revealed: true,
    energy_cost: 3,
    energy_return: 8,
    start_date: new Date('2026-01-01'),
    goals: [],
    completions: [],
    ...over,
  }) as Habit;

const carried = habit({ id: 8, name: MORNING_PAGES, is_carryover: true, energy_cost: 2 });
const second = habit({ id: 9, name: COLD_SHOWER, energy_cost: 6, energy_return: 4 });

const renderModal = (existingHabits?: readonly Habit[], onSaveHabits = jest.fn()) => ({
  onSaveHabits,
  ...render(
    <OnboardingModal
      visible
      onClose={jest.fn()}
      onSaveHabits={onSaveHabits}
      existingHabits={existingHabits}
    />,
  ),
});

/** The "x" on the nth habit chip -- the modal's own close button also reads "x". */
const removeChip = (result: ReturnType<typeof render>, index: number) =>
  within(result.getAllByTestId('habit-chip')[index]!).getByText('\u00d7');

/** Step 1 -> the cost step, clearing the "fewer than ten" nudge if it appears. */
const pressContinue = (result: ReturnType<typeof render>) => {
  fireEvent.press(result.getByTestId('continue-button'));
  const warn = result.queryByTestId('count-warning-continue');
  if (warn) fireEvent.press(warn);
};

describe('OnboardingModal review step', () => {
  it('offers each existing habit a keep checkbox before the add-habits step', () => {
    const { getByTestId, getByText, queryByTestId, queryByPlaceholderText } = renderModal([
      habit(),
    ]);

    getByTestId('review-step');
    getByText('🧘 Meditate');
    expect(getByTestId('review-keep-7').props.accessibilityState.checked).toBe(true);
    expect(queryByPlaceholderText(HABIT_NAME_PLACEHOLDER)).toBeNull();
    expect(queryByTestId('habit-input')).toBeNull();
  });

  it('starts a user with no habits on the add-habits step, exactly as before', () => {
    const { getByTestId, queryByTestId } = renderModal([]);

    getByTestId('habit-input');
    expect(queryByTestId('review-step')).toBeNull();
  });

  it('treats a store of nothing but demo tiles as a first run', () => {
    const { getByTestId, queryByTestId } = renderModal([habit({ isDemoSeed: true })]);

    getByTestId('habit-input');
    expect(queryByTestId('review-step')).toBeNull();
  });

  it('treats a store of nothing but rows this device minted as a first run', () => {
    const { getByTestId, queryByTestId } = renderModal([habit({ hasClientMintedIds: true })]);

    getByTestId('habit-input');
    expect(queryByTestId('review-step')).toBeNull();
  });

  it('opens a habit carried from before the program on bring along', () => {
    const { getByTestId } = renderModal([carried]);

    expect(getByTestId('review-bring-along-8').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('review-re-rate-8').props.accessibilityState.selected).toBe(false);
  });

  it('opens a habit already in the program lap on re-rate', () => {
    const { getByTestId } = renderModal([habit()]);

    expect(getByTestId('review-re-rate-7').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('review-bring-along-7').props.accessibilityState.selected).toBe(false);
  });

  it('offers neither destination as the answer: both are pressable and neither is disabled', () => {
    const { getByTestId } = renderModal([habit()]);

    for (const testID of ['review-bring-along-7', 'review-re-rate-7']) {
      expect(getByTestId(testID).props.accessibilityState.disabled).toBeFalsy();
    }
  });

  it('unticks and re-ticks a row without asking anything', () => {
    const { getByTestId, queryByTestId } = renderModal([habit()]);

    fireEvent.press(getByTestId('review-keep-7'));
    expect(getByTestId('review-keep-7').props.accessibilityState.checked).toBe(false);
    expect(queryByTestId('review-re-rate-7')).toBeNull();
    expect(queryByTestId('release-confirm')).toBeNull();

    fireEvent.press(getByTestId('review-keep-7'));
    expect(getByTestId('review-keep-7').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('review-re-rate-7').props.accessibilityState.selected).toBe(true);
  });
});

describe('OnboardingModal review step, moving on', () => {
  it('seeds the add-habits step with a chip for each re-rated habit', () => {
    const { getByTestId, getByText, queryByText } = renderModal([habit(), carried]);

    fireEvent.press(getByTestId('review-continue'));

    getByText(`🧘 ${MEDITATE}`);
    expect(queryByText(`🧘 ${MORNING_PAGES}`)).toBeNull();
  });

  it('counts only the habits competing for a program slot against the ceiling', () => {
    const { getByTestId } = renderModal([habit(), carried, second]);

    fireEvent.press(getByTestId('review-continue'));

    expect(getByTestId('habit-count')).toHaveTextContent('2 / 10');
  });

  it("starts a re-rated habit's sliders where the user last left them", () => {
    const result = renderModal([habit(), second]);

    fireEvent.press(result.getByTestId('review-continue'));
    const input = result.getByTestId('habit-input');
    fireEvent.changeText(input, 'Stretch');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    pressContinue(result);

    expect(result.getAllByTestId('cost-slider').map((s) => s.props.value)).toEqual([3, 6, 5]);

    fireEvent.press(result.getByTestId('continue-button'));

    expect(result.getAllByTestId('return-slider').map((s) => s.props.value)).toEqual([8, 4, 5]);
  });

  it('keeps a brought-along habit out of the energy steps entirely', () => {
    const result = renderModal([habit(), carried]);

    fireEvent.press(result.getByTestId('review-continue'));
    pressContinue(result);

    expect(result.getByText('Energy Cost')).toBeTruthy();
    expect(result.queryByText(`🧘 ${MORNING_PAGES}`)).toBeNull();
    expect(result.getAllByTestId(/^energy-tile-/)).toHaveLength(1);
  });

  it('returns to the review step with every answer intact', () => {
    const result = renderModal([habit(), second]);

    fireEvent.press(result.getByTestId('review-bring-along-9'));
    fireEvent.press(result.getByTestId('review-continue'));
    fireEvent.press(result.getByTestId('add-habits-back'));

    result.getByTestId('review-step');
    expect(result.getByTestId('review-bring-along-9').props.accessibilityState.selected).toBe(true);
    expect(result.getByTestId('review-re-rate-7').props.accessibilityState.selected).toBe(true);
  });

  it('offers no way back from a first run, which has no review step behind it', () => {
    const { queryByTestId } = renderModal([]);

    expect(queryByTestId('add-habits-back')).toBeNull();
  });
});

describe('OnboardingModal release confirmation', () => {
  it('names what goes, and says the history goes with it', () => {
    const result = renderModal([habit(), second]);

    fireEvent.press(result.getByTestId('review-keep-7'));
    fireEvent.press(result.getByTestId('review-continue'));

    result.getByTestId('release-confirm');
    expect(result.getByText(/Meditate will be deleted/)).toBeTruthy();
    expect(result.getByText(/every check-in and goal held there goes too/)).toBeTruthy();
    expect(result.getByText(/no way to bring it back/)).toBeTruthy();
  });

  it('names each of several habits rather than counting them', () => {
    const result = renderModal([habit(), second]);

    fireEvent.press(result.getByTestId('review-keep-7'));
    fireEvent.press(result.getByTestId('review-keep-9'));
    fireEvent.press(result.getByTestId('review-continue'));

    expect(result.getByText(/Meditate and Cold shower will be deleted/)).toBeTruthy();
  });

  it('leaves everything exactly as it was when the user backs out', () => {
    const { onSaveHabits, ...result } = renderModal([habit(), second]);

    fireEvent.press(result.getByTestId('review-keep-7'));
    fireEvent.press(result.getByTestId('review-continue'));
    fireEvent.press(result.getByTestId('release-cancel'));

    result.getByTestId('review-step');
    expect(result.getByTestId('review-keep-7').props.accessibilityState.checked).toBe(false);
    expect(result.getByTestId('review-keep-9').props.accessibilityState.checked).toBe(true);
    expect(onSaveHabits).not.toHaveBeenCalled();
  });

  it('carries the user forward once they confirm', () => {
    const result = renderModal([habit(), second]);

    fireEvent.press(result.getByTestId('review-keep-7'));
    fireEvent.press(result.getByTestId('review-continue'));
    fireEvent.press(result.getByTestId('release-let-go'));

    result.getByTestId('habit-input');
    expect(result.getByTestId('habit-count')).toHaveTextContent('1 / 10');
  });

  it('asks before dropping a chip that stands for a habit the user already had', () => {
    const result = renderModal([habit(), second]);

    fireEvent.press(result.getByTestId('review-continue'));
    fireEvent.press(removeChip(result, 0));

    result.getByTestId('release-confirm');
    expect(result.getByTestId('habit-count')).toHaveTextContent('2 / 10');
  });

  it('drops the chip and unticks its row once that is confirmed', () => {
    const result = renderModal([habit(), second]);

    fireEvent.press(result.getByTestId('review-continue'));
    fireEvent.press(removeChip(result, 0));
    fireEvent.press(result.getByTestId('release-let-go'));

    expect(result.getByTestId('habit-count')).toHaveTextContent('1 / 10');
    fireEvent.press(result.getByTestId('add-habits-back'));
    expect(result.getByTestId('review-keep-7').props.accessibilityState.checked).toBe(false);
  });

  it('drops a habit the user typed themselves without any ceremony', () => {
    const result = renderModal([]);

    const input = result.getByTestId('habit-input');
    fireEvent.changeText(input, 'Stretch');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    fireEvent.press(removeChip(result, 0));

    expect(result.queryByTestId('release-confirm')).toBeNull();
    expect(result.getByTestId('habit-count')).toHaveTextContent('0 / 10');
  });

  it('still routes the close button through the discard path, mutating nothing', () => {
    const { onSaveHabits, ...result } = renderModal([habit()]);

    fireEvent.press(result.getByTestId('review-keep-7'));
    fireEvent.press(result.getByTestId('onboarding-close'));

    result.getByTestId('discard-confirm');
    fireEvent.press(result.getByTestId('discard-exit'));
    expect(onSaveHabits).not.toHaveBeenCalled();
  });

  it('still routes an overlay tap through the discard path', () => {
    const result = renderModal([habit()]);

    fireEvent.press(result.getByTestId('onboarding-overlay'));

    result.getByTestId('discard-confirm');
  });
});

describe('OnboardingModal review step, bringing everything along', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    act(() => {
      useProgramStore.getState().reset();
    });
  });

  it('lets a user who brings every habit along finish without inventing a new one', () => {
    // A legitimate combination of the choices this step offers: everything I
    // have is already part of me, and I am taking nothing new on this lap.
    // Offering that fork and then refusing to let the user out of it is a dead
    // end behind an invitation.
    const { onSaveHabits, ...result } = renderModal([habit(), second]);

    fireEvent.press(result.getByTestId('review-bring-along-7'));
    fireEvent.press(result.getByTestId('review-bring-along-9'));
    fireEvent.press(result.getByTestId('review-continue'));

    expect(result.getByTestId('habit-count')).toHaveTextContent('0 / 10');
    fireEvent.press(result.getByTestId('finish-without-adding'));

    const plan = onSaveHabits.mock.calls[0]?.[0] as HabitMergePlan;
    expect(plan).toContainEqual(expect.objectContaining({ kind: 'brought-along', habitId: 7 }));
    expect(plan).toContainEqual(expect.objectContaining({ kind: 'brought-along', habitId: 9 }));
  });

  it('still refuses to save a first run that has entered nothing at all', () => {
    // The mirror case, and the reason the affordance is conditional: a first
    // run with an empty pool has decided nothing, so there is nothing to save.
    const { queryByTestId, getByTestId } = renderModal([]);

    expect(queryByTestId('finish-without-adding')).toBeNull();
    expect(getByTestId('continue-button').props.accessibilityState.disabled).toBe(true);
  });

  it('offers the ordinary path again the moment a habit enters the pool', () => {
    const result = renderModal([habit()]);

    fireEvent.press(result.getByTestId('review-bring-along-7'));
    fireEvent.press(result.getByTestId('review-continue'));
    const input = result.getByTestId('habit-input');
    fireEvent.changeText(input, 'Stretch');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });

    expect(result.queryByTestId('finish-without-adding')).toBeNull();
    expect(result.getByTestId('continue-button').props.accessibilityState.disabled).toBeFalsy();
  });

  it('shows a habit the user has already lived the beginning it keeps', () => {
    // `hasBegun` withholds the staggered start date server-side, so a reorder
    // row displaying one promises a date the save will discard.
    useProgramStore.getState().hydrateProgramStartDate(new Date(2026, 5, 1));
    const result = renderModal([habit({ start_date: new Date(2026, 0, 1), streak: 4 })]);

    fireEvent.press(result.getByTestId('review-continue'));
    pressContinue(result);
    fireEvent.press(result.getByTestId('continue-button'));
    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });
    act(() => {
      jest.advanceTimersByTime(REVEAL_TOTAL_MS);
    });

    expect(result.getByText('Jan 1')).toBeTruthy();
    expect(result.queryByText('Jun 1')).toBeNull();
  });
});

describe('OnboardingModal review step, what the save is handed', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    act(() => {
      useProgramStore.getState().reset();
    });
  });

  const runToFinish = async (result: ReturnType<typeof render>) => {
    pressContinue(result);
    fireEvent.press(result.getByTestId('continue-button'));
    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });
    act(() => {
      jest.advanceTimersByTime(REVEAL_TOTAL_MS);
    });
    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(10);
    });
    fireEvent.press(result.getByTestId('finish-setup'));
  };

  it('states a plan naming every habit the user decided about', async () => {
    const { onSaveHabits, ...result } = renderModal([habit(), carried, second]);

    fireEvent.press(result.getByTestId('review-keep-9'));
    fireEvent.press(result.getByTestId('review-continue'));
    fireEvent.press(result.getByTestId('release-let-go'));
    await runToFinish(result);

    const plan = onSaveHabits.mock.calls[0]?.[0] as HabitMergePlan;
    expect(plan).toContainEqual(expect.objectContaining({ kind: 're-rated', habitId: 7 }));
    expect(plan).toContainEqual(expect.objectContaining({ kind: 'brought-along', habitId: 8 }));
    expect(plan).toContainEqual({ kind: 'released', habitId: 9 });
  });

  it('hands a first run the bare picks it always did', async () => {
    const { onSaveHabits, ...result } = renderModal([]);

    const input = result.getByTestId('habit-input');
    fireEvent.changeText(input, 'Stretch');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    await runToFinish(result);

    const picks = onSaveHabits.mock.calls[0]?.[0] as readonly OnboardingHabit[];
    expect(picks).toHaveLength(1);
    expect(picks[0]).toEqual(expect.objectContaining({ name: 'Stretch' }));
    expect('kind' in (picks[0] as object)).toBe(false);
  });

  it('lands a returning user back on the review step after finishing', async () => {
    const result = renderModal([habit()]);

    fireEvent.press(result.getByTestId('review-continue'));
    await runToFinish(result);

    result.getByTestId('review-step');
  });

  it('lands a first-run user back on the add-habits step after finishing', async () => {
    const result = renderModal([]);

    const input = result.getByTestId('habit-input');
    fireEvent.changeText(input, 'Stretch');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    await runToFinish(result);

    result.getByTestId('habit-input');
  });
});

describe('OnboardingModal start-date seed', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    act(() => {
      useProgramStore.getState().reset();
    });
  });

  const advanceToReorder = (result: ReturnType<typeof render>) => {
    pressContinue(result);
    fireEvent.press(result.getByTestId('continue-button'));
    act(() => {
      fireEvent.press(result.getByTestId('continue-button'));
    });
    act(() => {
      jest.advanceTimersByTime(REVEAL_TOTAL_MS);
    });
  };

  it('opens the picker on the day the program already begins, not on today', () => {
    // Saving a scaffolding pass is an explicit anchor write. A picker seeded
    // with today re-answers a question the user already answered, and moves the
    // whole course calendar for a returning user who never touched it.
    useProgramStore.getState().hydrateProgramStartDate(new Date(2026, 0, 15));
    const result = renderModal([habit()]);

    fireEvent.press(result.getByTestId('review-continue'));
    advanceToReorder(result);

    expect(result.getByText('Beige begins on:')).toBeTruthy();
    expect(result.UNSAFE_getByProps({ value: '2026-01-15' }).props.minDate).toBe('2026-01-15');
  });

  it('opens on today when the user has never chosen a beginning', () => {
    useProgramStore.getState().hydrateProgramStartDate(null);
    const today = new Date();
    const iso = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');
    const result = renderModal([]);

    const input = result.getByTestId('habit-input');
    fireEvent.changeText(input, 'Stretch');
    fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });
    advanceToReorder(result);

    expect(result.UNSAFE_getByProps({ value: iso }).props.minDate).toBe(iso);
  });
});
